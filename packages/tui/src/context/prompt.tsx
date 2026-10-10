import { createSimpleContext } from "./helper"
import { createSignal } from "solid-js"
import type { PromptRef } from "../component/prompt"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    // Als Signal statt als schlichte Variable: der Prompt-Footer wertet
    // `current.current.text` in einem Memo aus und muss neu laufen, wenn die
    // Route den Ref erst nach dem Mount setzt. Mit einer reinen Variable
    // bliebe dieses Memo dauerhaft bei `undefined`.
    const [ref, setRef] = createSignal<PromptRef | undefined>(undefined)

    return {
      get current() {
        return ref()
      },
      set(ref: PromptRef | undefined) {
        setRef(() => ref)
      },
    }
  },
})
