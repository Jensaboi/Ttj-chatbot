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
    skipPage: [37, 38, 39, 40],
  },
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/04-dialog-och-ordergivning_.pdf",
    startPage: 5,
    name: "4 Dialog och ordergivning",
    skipPages: [29],
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
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/09hms-sparrfard---system-h-m-och-s.pdf",
    startPage: 5,
    name: "9HMS Spärrfärd - System H, M och S",
  },
];

export async function extractTextFromPdfs(urls = []) {
  try {
    if (!Array.isArray(urls)) throw new Error("Urls must be typeof array.");
    if (urls.length === 0) throw new Error("Urls is empty.");

    const parsers = urls.map(obj => ({
      parse: new PDFParse({ url: obj.url }),
      startPage: obj?.startPage ?? 0,
      name: obj?.name ?? "",
      skipPages: obj?.skipPages ?? [],
    }));

    const parsedPdfs = await Promise.all(
      parsers.map(async pdf => {
        const { pages } = await pdf.parse.getText();

        const startPage = pdf.startPage;
        const name = pdf.name;
        const regex = new RegExp("\\d+\\s+" + name, "g");
        const skipPages = pdf.skipPages;

        pages.pop(); //remove last page before
        const text = pages
          .filter(page => page.num >= startPage)
          .filter(page => !skipPages.includes(page.num))
          .map(page => page.text)
          .join(" ")
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
    const regex = /^(\d(?:\.\d\d?)?)\s{1,}([A-ZÅÄÖa-zåäö”"].*)\n/gm;

    const inledning = [...text.matchAll(/^[Ii]nledning\n/gm)];

    const matches = [inledning[0], ...text.matchAll(regex)];

    const sections = matches.map((match, i) => {
      if (!match) return null;

      const heading = match[0];

      let content;
      if (i + 1 === matches.length) {
        content = match.input.slice(
          match.index + heading.length,
          match.input.length,
        );
      } else {
        content = match.input.slice(
          match.index + heading.length,
          matches[i + 1].index,
        );
      }

      return { name, heading, content };
    });

    temp.push(...sections.filter(item => item));
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
          name: section.name,
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

export function prettifyTermsModule(sections) {
  return sections.map(section => ({
    ...section,
    content: section.content.split("  ").join(" = "),
  }));
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
          name: chunk.name,
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

    const termsPdf = await extractTextFromPdfs([
      {
        url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/01-termer.pdf",
        startPage: 5,
        name: "1 Termer",
        skipPages: [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47],
      },
    ]);
    console.log("Extracted terms text successfully! ✅");

    const termsSections = parsePdfsToSections(termsPdf);
    console.log("Prased and generated terms sections successfully! ✅");

    const prettyTerms = prettifyTermsModule(termsSections);
    console.log("Prettifyed terms sections successfully! ✅");

    const termsChunks = await chunkSections(prettyTerms);
    console.log("Terms text chunked successfully! ✅");

    const termsEmbeddings = await createEmbeddings(termsChunks);
    console.log("Embeddings created successfully! ✅");

    await supabase.from("embeddings").insert(termsEmbeddings);
    console.log("Embeddings inserted to vector db successfully! ✅");

    console.log("Script ran successfully! ✅");
  } catch (err) {
    console.log("Failed to seed vector db! 🚫");
    console.error(err);
  }
}

//seedVectorDb();

const pdfs = await extractTextFromPdfs([
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/03hms-signaler---system-h-m-och-s.pdf",
    startPage: 11,
    name: "3HMS Signaler - System H, M och S",
  },
]);
console.log("Text extracted from pdfs successfully! ✅");

const sections = parsePdfsToSections(pdfs);
console.log("Prased and generated pdf sections successfully! ✅");

console.log(sections);
