import "./config.js";
import express, { Router } from "express";
import cors from "cors";
import { openai, supabase } from "./config.js";
import { messages } from "./utility/constants.js";

const app = express();

app.use(cors());

app.use(express.json());

const chatRouter = Router();

app.use("/api/chat", chatRouter);

chatRouter.get("/", async (req, res) => {
  const { input } = req.body;

  if (!input)
    return res.status(400).json({
      status: 400,
      message: "Input required to get an response.",
    });

  const embeddingResponse = await openai.embeddings.create({
    input,
    model: process.env.OPENAI_EMBEDDING_MODEL,
  });

  const embedding = embeddingResponse.data[0].embedding;

  const { data } = await supabase.rpc("match_embeddings", {
    query_embedding: embedding,
    match_threshold: 0.5,
    match_count: 15,
  });

  const context = data.map(item => item.content).join(" ");

  messages.push({
    role: "user",
    content: `
      Kontext: ${context}

      Fråga: """
      ${input}
      """
      `,
  });

  const chatResponse = await openai.responses.create({
    model: process.env.OPENAI_CHAT_MODEL,
    input: messages,
  });

  console.log(messages);

  console.log(chatResponse.output_text);
  return res.status(200).json({ message: chatResponse.output_text });
});

app.use((req, res, next) => {
  return res.status(404).json({ status: 404, message: "Not found." });
});

app.listen(3000, () => console.log(`Server connected: 3000`));
