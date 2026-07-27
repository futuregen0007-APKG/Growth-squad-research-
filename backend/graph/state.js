import { Annotation } from "@langchain/langgraph";

export const GraphState = Annotation.Root({
    messages: Annotation({
        reducer: (x, y) => x.concat(y),
        default: () => [],
    }),
});