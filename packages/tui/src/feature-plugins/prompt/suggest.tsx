import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { Spinner } from "../../component/spinner"
import { usePromptRef } from "../../context/prompt"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import { emptyPrompt } from "../../prompt/history"
import { instructions, parseSuggestions, toOptions, type Suggestion } from "../../util/suggest"

/**
 * Fragt das Modell nach dem nächsten sinnvollen Schritt und lässt auswählen.
 *
 * Der Aufruf läuft über `session.generate`, das den Session-Kontext nutzt, ohne
 * die Session zu verändern — ein Vorschlag darf den Verlauf nicht berühren.
 * Der gewählte Vorschlag landet im Composer statt direkt im Versand: der Nutzer
 * soll ihn vor dem Abschicken lesen und ändern können.
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

          setPending(true)
          try {
            const prompt = focus ? `${instructions}\n\nBesonderes Augenmerk: ${focus}` : instructions
            const result = await context.client.session.generate({ sessionID, prompt })
            const parsed = parseSuggestions(result.text)

            if (parsed.suggestions.length === 0) {
              toast.show({ message: "Keine Vorschläge erhalten", variant: "warning" })
              return
            }

            if (parsed.shape !== "json") {
              toast.show({
                message: `Modell antwortete nicht im JSON-Format (${parsed.shape})`,
                variant: "warning",
              })
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
