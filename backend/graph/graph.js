import { StateGraph, START, END } from "@langchain/langgraph";

import { GraphState } from "./state.js";
import { chatbot } from "./nodes.js";

const builder = new StateGraph(GraphState);

builder.addNode("chatbot", chatbot);

builder.addEdge(START, "chatbot");

builder.addEdge("chatbot", END);

export const graph = builder.compile();