import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";

export interface PageContent {
  pageNumber: number;
  text: string;
  hasImages: boolean;
  hasTables: boolean;
}

export interface PdfContent {
  totalPages: number;
  pages: PageContent[];
  fullText: string;
}

export async function extractPdfText(pdfBuffer: Buffer): Promise<PdfContent> {
  // Dynamically import pdf-parse to avoid issues with ESM
  const pdfParse = await import("pdf-parse");
  const parse = pdfParse.default;

  const pages: PageContent[] = [];
  let currentPage = 0;

  const data = await parse(pdfBuffer, {
    pagerender: (pageData: any) => {
      return pageData.getTextContent().then((textContent: any) => {
        let text = "";
        let lastY: number | undefined;
        for (const item of textContent.items) {
          if (lastY !== item.transform[5] && lastY !== undefined) {
            text += "\n";
          }
          text += item.str;
          lastY = item.transform[5];
        }

        currentPage++;
        const hasImages = text.length < 100 && currentPage > 1; // heuristic: sparse text likely has image
        const hasTables = /(\t|  {3,})/.test(text) || /\|.*\|/.test(text);

        pages.push({
          pageNumber: currentPage,
          text: text.trim(),
          hasImages,
          hasTables,
        });

        return text;
      });
    },
  });

  return {
    totalPages: data.numpages,
    pages,
    fullText: data.text,
  };
}

export function chunkText(text: string, maxChunkSize = 6000): string[] {
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > maxChunkSize && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
