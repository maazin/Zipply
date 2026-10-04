// Extract text (and, for PDFs, positioned text items) from a resume file in the
// browser. pdf.js replaces pdftotext; mammoth reads Word files.
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import mammoth from 'mammoth'
import type { PageLayout, ResumeContent, TextItem } from '@/shared/types'
import { toB64 } from './crypto'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export const ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** Rebuild reading-order text from positioned items: new line when the baseline moves. */
export function itemsToText(pages: PageLayout[]): string {
  return pages
    .map((p) => {
      let out = ''
      let lastY: number | null = null
      for (const it of p.items) {
        if (lastY != null && Math.abs(it.y - lastY) > Math.max(2, it.h * 0.5)) out += '\n'
        else if (out && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' '
        out += it.str
        lastY = it.y
      }
      return out
    })
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
}

async function extractPdf(data: ArrayBuffer): Promise<ResumeContent> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: true }).promise
  const pages: PageLayout[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const items: TextItem[] = []
    for (const raw of tc.items) {
      if (!('str' in raw) || !raw.str) continue
      items.push({ str: raw.str, x: raw.transform[4], y: raw.transform[5], w: raw.width, h: raw.height || Math.abs(raw.transform[3]) })
    }
    pages.push({ width: vp.width, height: vp.height, items })
  }
  await doc.destroy()
  return { text: itemsToText(pages), pages }
}

async function extractDocx(data: ArrayBuffer): Promise<ResumeContent> {
  const { value } = await mammoth.extractRawText({ arrayBuffer: data })
  return { text: value.replace(/\n{3,}/g, '\n\n').trim() }
}

export async function readResumeFile(file: File): Promise<{ content: ResumeContent; data: string; mime: string }> {
  const buf = await file.arrayBuffer()
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  const isDocx = /wordprocessingml/.test(file.type) || /\.docx$/i.test(file.name)
  if (!isPdf && !isDocx) throw new Error('Use a PDF or Word (.docx) file.')
  if (file.size > 8 * 1024 * 1024) throw new Error('That file is over 8 MB.')
  const content = isPdf ? await extractPdf(buf) : await extractDocx(buf)
  return {
    content,
    data: toB64(buf),
    mime: isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
}
