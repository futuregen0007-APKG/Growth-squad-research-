import express from "express";
import { HumanMessage } from "@langchain/core/messages";
import { graph } from "../graph/graph.js";

const router = express.Router();

router.post("/", async (req, res) => {

    try {

        const { message } = req.body;

        const result = await graph.invoke({

            messages: [
                new HumanMessage(message)
            ]

        });

        const aiMessage =
            result.messages[result.messages.length - 1];

        res.json({

            reply: aiMessage.content

        });

    } catch (err) {

        console.log(err);

        res.status(500).json({

            error: err.message

        });

    }

});

export default router;