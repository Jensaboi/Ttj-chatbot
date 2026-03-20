import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { openai, supabase } from "./config.js";

export async function getTextFromPdf({
  url,
  partial,
  startPage = 0,
  skipPage = [],
}) {
  try {
    if (!url) throw new Error("Url is required.");

    const parser = new PDFParse({ url });

    const { pages } = await parser.getText({ partial });

    if (!partial) pages.pop(); //remove last page, only if you didnt select one

    const text = pages
      .filter(page => page.num >= startPage)
      .filter(page => !skipPage.includes(page.num))
      .map(page => page.text)
      .join("\n")
      .replace(/-\n/g, "");

    return { text };
  } catch (err) {
    console.error(err);
    throw new Error("Failed to get text from pdf: " + err.message, {
      cause: err,
    });
  }
}

function parseText(text) {
  const pageAndModulRegex = /^\d+\s?\t.+\n/gm;
  const headingRegex = /^(\d(?:\.\d\d?)?)\s{1,}\t?([A-ZÅÄÖa-zåäö”" ,-]+\n)/gm;

  const pageMatches = [...text.matchAll(pageAndModulRegex)];
  const headingMatches = [...text.matchAll(headingRegex)];

  const sections = headingMatches.map((item, i) => {
    const match = item[0];
    const startIndex = item.index + match.length;
    const nextMatch = headingMatches[i + 1];
    let endIndex = nextMatch?.index;

    if (headingMatches.length - 1 === i) endIndex = text.length;

    let content = text
      .slice(startIndex, endIndex)
      .replace(pageAndModulRegex, "")
      .replace(/\n•/g, "-BULLET-")
      .replace(/\n/g, " ")
      .replace(/-BULLET-/g, "\n•");

    let pageAndModule =
      pageMatches.find(page => page.index >= startIndex)?.[0] ??
      pageMatches[pageMatches.length - 1][0];

    const cleanedModule = pageAndModule
      .replace(/\d+\t/gm, "")
      .replace(/\n/gm, "");

    const heading = match.replace(/\t/, "").replace(/\n/, "");

    const sectionNumber = heading.match(/^\d+(\.\d+)?/)?.[0];

    const section = heading.replace(sectionNumber, "")?.trim();

    let [module, system] = cleanedModule.split("–");

    module = module?.trim() ?? "";
    system = system?.trim() ?? "";

    const [moduleNumber, operation] = module.split(" ");

    return {
      module,
      moduleNumber,
      operation,
      system,
      heading,
      sectionNumber,
      section,
      content,
      startIndex,
      endIndex,
    };
  });

  return sections;
}

async function chunkSections(sections) {}

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
      {
        url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/07-vagvakt.pdf",
        startPage: 5,
        name: "7 Vägvakt",
      },
    ];
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

const pdf = await getTextFromPdf({
  url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/10hms-vaxling--system-h-m-och-s.pdf",
  startPage: 5,
  skipPage: [7, 6],
});

const sections = parseText(pdf.text);

console.log({ text: pdf.text });

console.log(sections.slice(0, 5));

//console.log(pdf);

//create chapter/section regex.
//matchAll with regex.
//create sections
//remove page/module text
//compare chapter/section index with page/module index
//give correct modulename and system to section
//Remove
