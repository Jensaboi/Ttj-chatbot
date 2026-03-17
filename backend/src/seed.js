import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { openai, supabase } from "./config.js";

const urls = [
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/08hm-tagfard---system-h-och-m.pdf",
    startPage: 5,
    name: "8HM Tågfärd - System H och M",
  },
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/10hms-vaxling--system-h-m-och-s.pdf",
    startPage: 5,
    name: "10HMS Växling – System H, M och S",
  },
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/04-dialog-och-ordergivning_.pdf",
    startPage: 5,
    name: "4 Dialog och ordergivning",
  },
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/11-broms.pdf",
    startPage: 5,
    name: "11 Broms",
  },
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/06-fara-och-olycka.pdf",
    startPage: 5,
    name: "6 Fara och olycka",
  },
];

export async function extractTextFromPdfs(urls = []) {
  try {
    if (!Array.isArray(urls)) throw new Error("Urls must be typeof array.");
    if (urls.length === 0) throw new Error("Urls is empty.");

    const parsers = urls.map(obj => ({
      parse: new PDFParse({ url: obj.url }),
      startPage: obj.startPage,
      name: obj.name,
    }));

    const parsedPdfs = await Promise.all(
      parsers.map(async pdf => {
        const { pages } = await pdf.parse.getText();

        const startPage = pdf?.startPage ?? 0;
        const name = pdf.name ?? "";
        const regex = new RegExp("\\d+\\s+" + name, "g");

        const text = pages
          .filter(page => page.num >= startPage)
          .map(page => page.text)
          .join(" ")
          .replace(/Inledning\n/, "")
          .replace(regex, "") //Remove uneccessary module name repetition and page number.
          .replace(/\t+/g, " ") // tabs → spaces
          .replace(/-\n/g, "") // fix hyphenated line breaks kör - tillstånd -> körtillstånd.
          .replace(/\n{3,}/g, "\n\n") // collapse large newline blocks.
          .trim();

        return { name, text };
      }),
    );

    return parsedPdfs;
  } catch (err) {
    console.error(err);
    throw new Error("Failed to extract text from pdf file: " + err.message, {
      cause: err,
    });
  }
}

function parsePdfsToSections(pdfs = []) {
  const temp = [];
  for (const pdf of pdfs) {
    const name = pdf.name;
    const text = pdf.text;

    const regex = /\d(\.\d)?  [A-ZÅÄÖ][a-zA-ZÅÄÖåäö ]+\n/gm;

    const headings = [...text.matchAll(regex)].map(arr => arr[0]);

    headings.unshift("Inledning");

    const chapters = text
      .split(regex)
      .filter(
        item => item?.trim() !== "" && item !== undefined && item.length > 5,
      );

    const sections = headings.map((heading, i) => {
      const content = chapters[i] ?? "";

      return { name, heading, content };
    });

    temp.push(...sections);
  }

  return temp;
}

export async function chunkSections(sections) {
  try {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 400,
      chunkOverlap: 100,
    });

    const chunks = await Promise.all(
      sections.map(async section => {
        const texts = await splitter.splitText(section.content);

        return texts.map(chunk => ({
          title: section.name,
          heading: section.heading,
          content: section.name + " " + section.heading + "\n" + chunk,
        }));
      }),
    );
    return chunks.flat();
  } catch (err) {
    console.error(err);
    throw new Error("Failed to chunk text: " + err.message, { cause: err });
  }
}

export async function createEmbeddings(chunks) {
  try {
    const embeddings = await Promise.all(
      chunks.map(async chunk => {
        const response = await openai.embeddings.create({
          input: chunk.content,
          model: process.env.OPENAI_EMBEDDING_MODEL,
        });

        return {
          title: chunk.title,
          heading: chunk.heading,
          content: chunk.content,
          embedding: response.data[0].embedding,
        };
      }),
    );

    return embeddings;
  } catch (err) {
    throw new Error("Failed to create embeddings: " + err.message, {
      cause: err,
    });
  }
}

async function seedVectorDb() {
  try {
    const pdfs = await extractTextFromPdfs(urls);
    console.log("Text extracted from pdfs successfully! ✅");

    const sections = parsePdfsToSections(pdfs);
    console.log("Prased and generated pdf sections successfully! ✅");

    const chunks = await chunkSections(sections);
    console.log("Text chunked successfully! ✅");

    const embeddings = await createEmbeddings(chunks);
    console.log("Embeddings created successfully! ✅");

    await supabase.from("embeddings").insert(embeddings);
    console.log("Embeddings inserted to vector db successfully! ✅");

    console.log("Supbase DB seeded successfully! ✅");
  } catch (err) {
    console.log("Failed to seed vector db! 🚫");
    console.error(err);
  }
}

seedVectorDb();

/*

const pdfs = await extractTextFromPdfs([
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/08hm-tagfard---system-h-och-m.pdf",
    startPage: 5,
    name: "8HM Tågfärd - System H och M",
  },
]);
console.log("Extracted text from pdfs successfully! ✅");

const sections = parsePdfsToSections(pdfs);
console.log("Pdfs parsed to sections successfully! ✅");

const chunks = await chunkSections(sections);
console.log("Text chunked successfully! ✅");

console.log(chunks);


*/
