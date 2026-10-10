import { Plugin } from "@opencode/plugin/tui"
import { ContextPulse } from "../../component/context-pulse"

export function SidebarContext(props: { context: Plugin.Context; sessionID: string }) {
  return <ContextPulse context={props.context} sessionID={props.sessionID} />
}

export default Plugin.define({
  id: "opencode.sidebar.context",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarContext context={context} sessionID={props.sessionID} />,
    })
  },
})
