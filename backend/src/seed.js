import { PDFParse } from "pdf-parse";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { openai, supabase } from "./config.js";

export async function extractTextFromPdfs(urls = []) {
  try {
    if (!Array.isArray(urls)) throw new Error("Urls must be typeof array.");
    if (urls.length === 0) throw new Error("Urls is empty.");

    const parsers = urls.map(obj => ({
      parse: new PDFParse({ url: obj.url }),
      startPage: obj?.startPage ?? 0,
      name: obj?.name ?? "",
      skipPages: obj?.skipPages ?? [],
      partial: obj?.partial,
    }));

    const parsedPdfs = await Promise.all(
      parsers.map(async pdf => {
        const { pages } = await pdf.parse.getText({ partial: pdf?.partial });

        const startPage = pdf.startPage;
        const name = pdf.name;
        const regex = new RegExp("\\d+\\s+" + name + ".+\\n", "g"); //matches module name
        const skipPages = pdf.skipPages;

        if (!pdf.partial) pages.pop(); //remove last page if you dont specificly select pages to parse

        let text = pages
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
    const module = name?.split("-")?.[0]?.trim() ?? "";
    const [moduleNumber, moduleName] = module.split(" ");
    const sectionNameRegex = /^(\d(?:\.\d\d?)?)\s{2,}([A-ZÅÄÖa-zåäö”"].*)\n/gm;

    const inledning = [...text.matchAll(/^[Ii]nledning\n/gm)];

    const matches = [inledning[0], ...text.matchAll(sectionNameRegex)];

    let chapter = null;
    let chapterNumber = null;

    const sections = matches.map((match, i) => {
      if (!match) return null;

      if (i < 10) console.log(match);

      const fullMatch = match[0];
      let section = match?.[2] ? match[2] : match[0] ? match[0] : "";
      let sectionNumber = match?.[1] ? parseFloat(match[1]) : null;

      if (Number.isInteger(sectionNumber) || sectionNumber === null) {
        chapter = section;
        chapterNumber = sectionNumber;
        sectionNumber = null;
        section = null;
      }

      let content;
      if (i + 1 === matches.length) {
        content = match.input.slice(
          match.index + fullMatch.length,
          match.input.length,
        );
      } else {
        content = match.input.slice(
          match.index + fullMatch.length,
          matches[i + 1].index,
        );
      }

      return {
        module,
        moduleName,
        moduleNumber,
        chapter,
        chapterNumber,
        section,
        sectionNumber,
        content,
      };
    });

    temp.push(...sections);
  }

  return temp;
}

async function chunkSections(sections) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  const chunks = await Promise.all(
    sections.map(
      async ({
        module,
        moduleName,
        moduleNumber,
        chapter,
        chapterNumber,
        section,
        sectionNumber,
        content,
      }) => {
        let string = content.replace(/\n/gm, " ");

        const texts = await splitter.splitText(string);

        const chunks = texts.map(chunk => ({
          module,
          moduleName,
          moduleNumber,
          chapter,
          chapterNumber,
          section,
          sectionNumber,
          chunk,
          text:
            `Modul: ${module}\n${moduleName}, ${chapterNumber ? `Kapitel ${chapterNumber}, ${chapter}\n` : ""}${sectionNumber ? `Avsnitt ${sectionNumber}, ${section}\n` : ""}` +
            chunk,
        }));

        return chunks;
      },
    ),
  );

  return chunks.flat();
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

//seedVectorDb();

const pdfs = await extractTextFromPdfs([
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/10hms-vaxling--system-h-m-och-s.pdf",
    startPage: 5,
    name: "10HMS Växling – System H, M och S",
    skipPage: [7, 37, 38, 39, 40],
  },
  {
    url: "https://bransch.trafikverket.se/contentassets/18aa4c18f60e48c398afa22e65079111/08hm-tagfard---system-h-och-m.pdf",
    startPage: 5,
    name: "8HM Tågfärd - System H och M",
  },
]);

//console.log(pdfs);

const sections = parsePdfsToSections(pdfs);

const testSections = sections.slice(0, 10);
//console.log(testSections);
//const chunks = await chunkSections(testSections);
//console.log(chunks);
