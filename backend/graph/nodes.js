import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

const model = new ChatOpenAI({
    model: "gpt-5",
    temperature: 1,
    apiKey: process.env.OPENAI_API_KEY,
});

export async function chatbot(state) {

    const response = await model.invoke(state.messages);

    return {
        messages: [response],
    };
}