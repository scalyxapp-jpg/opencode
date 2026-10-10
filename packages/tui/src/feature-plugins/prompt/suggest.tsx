import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { Spinner } from "../../component/spinner"
import { useConfig } from "../../config"
import { usePromptRef } from "../../context/prompt"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { emptyPrompt } from "../../prompt/history"
import { buildPrompt, collectEvidence, parseSuggestions, toOptions, type Suggestion } from "../../util/suggest"

export const AUTO_SUGGEST_EXPERIMENT = "auto-suggest"

/**
 * Fragt das Modell nach dem nächsten sinnvollen Schritt und lässt auswählen.
 *
 * Der Aufruf läuft über `session.generate`, das den Session-Kontext nutzt, ohne
 * die Session zu verändern — ein Vorschlag darf den Verlauf nicht berühren.
 *
 * Die Belege stammen ausschließlich aus den Tool-Aufrufen dieser Session. Gibt
 * es keine, wird gar nicht erst gefragt: ein Vorschlag ohne Grundlage wäre
 * geraten, und geratene Vorschläge sind schlimmer als keine.
 *
 * Der gewählte Vorschlag landet im Composer statt direkt im Versand, damit er
 * vor dem Abschicken lesbar und änderbar bleibt.
 */
export default Plugin.define({
  id: "opencode.suggest",
  setup(context) {
    const [pending, setPending] = createSignal(false)

    context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const theme = useTheme()
        return (
          <Show when={pending()}>
            <box flexShrink={0}>
              <Spinner color={theme.hue.interactive[200]}>/next</Spinner>
            </box>
          </Show>
        )
      },
    })

    context.ui.slot({
      append: "app",
      render() {
        const toast = useToast()
        const promptRef = usePromptRef()
        const config = useConfig()

        // Merkt sich den Turn, für den zuletzt gefragt wurde, damit der Dialog
        // nicht bei jeder Zustandsaenderung erneut aufgeht.
        let answered = ""
        let armed = true

        const ask = async (focus: string | undefined, sessionID: string) => {
          if (pending()) return

          // Eine frische Session hat serverseitig noch keine ID; `session.generate`
          // antwortet dort mit 404. In einer leeren Session gäbe es ohnehin keinen
          // Verlauf, auf den sich ein Vorschlag stützen könnte.
          if (!context.data.session.get(sessionID)) {
            toast.show({
              message: "Vorschläge brauchen einen Verlauf — schreib zuerst eine Nachricht",
              variant: "warning",
            })
            return
          }

          const evidence = collectEvidence(context.data.session.message.list(sessionID))
          const grounded = evidence.files.length > 0 || evidence.commands.length > 0 || evidence.failures.length > 0
          if (!grounded) {
            toast.show({
              message: "Keine Belege in dieser Session — kein Vorschlag ohne Grundlage",
              variant: "warning",
            })
            return
          }

          setPending(true)
          try {
            const generated = await context.client.session.generate({
              sessionID,
              prompt: buildPrompt(evidence, focus),
            })
            const parsed = parseSuggestions(generated.text)

            if (parsed.suggestions.length === 0) {
              toast.show({ message: "Die Belege geben keinen nächsten Schritt her", variant: "info" })
              return
            }

            if (parsed.shape !== "json") {
              toast.show({ message: `Modell antwortete nicht im JSON-Format (${parsed.shape})`, variant: "warning" })
            }

            const chosen = await context.ui.dialog.select<Suggestion>({
              title: "Was als Nächstes?",
              placeholder: "Vorschlag filtern",
              options: toOptions(parsed.suggestions),
            })
            if (!chosen) return

            promptRef.current?.set({ ...emptyPrompt(), text: chosen.title })
          } catch (cause) {
            toast.error(cause)
          } finally {
            setPending(false)
          }
        }

        // Automatisch nach einem abgeschlossenen Schritt, sofern freigeschaltet.
        // Bewusst zurückhaltend: nicht während der Nutzer tippt, nicht zweimal
        // pro Turn, und nicht, solange schon etwas läuft.
        createEffect(() => {
          const route = context.ui.router.current()
          if (route.type !== "session") return
          const status = context.data.session.status(route.sessionID)

          if (status !== "idle") {
            armed = true
            return
          }
          if (!config.data.experimental?.[AUTO_SUGGEST_EXPERIMENT]) return
          if (!armed || pending()) return

          const messages = context.data.session.message.list(route.sessionID)
          const last = [...messages].reverse().find((message) => message.type === "assistant")
          if (!last || last.id === answered) return
          // Wer gerade tippt, will keinen Dialog vor die Nase gesetzt bekommen.
          if (promptRef.current?.current.text) return

          const evidence = collectEvidence(messages)
          if (evidence.turns < 2) return
          if (evidence.files.length + evidence.commands.length + evidence.failures.length === 0) return

          armed = false
          answered = last.id
          void ask(undefined, route.sessionID)
        })

        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "session.suggest",
              title: "Suggest next steps",
              description: "Fragt das Modell nach dem nächsten Schritt und lässt auswählen",
              group: "Session",
              palette: true,
              slash: { name: "next", arguments: true },
              run(input) {
                const route = context.ui.router.current()
                if (route.type !== "session") {
                  toast.show({ message: "Open a session first", variant: "warning" })
                  return
                }
                void ask(input?.trim() || undefined, route.sessionID)
              },
            },
          ],
        }))
        return null
      },
    })
  },
})
