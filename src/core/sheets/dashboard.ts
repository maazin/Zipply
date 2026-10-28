/*
 * The Dashboard tab: plain spreadsheet formulas over the Applications tab, so it
 * keeps itself up to date with no code. Activity calendar and last-7/30-day
 * counts adapted from JobSync (https://github.com/Gsync/jobsync)
 * src/actions/dashboard, MIT; staleness check from ai-job-search's gmail-sync (MIT).
 *
 * Layout (content in B:O, 14 columns; chart and list data in hidden columns Q:AK):
 *   2-3    banner
 *   5-7    seven cards
 *   9-15   what stands out (sentences written by formulas)
 *   17-37  where your applications went (a Sankey drawn by QuickChart)
 *   39-55  applications per week | where things stand (charts)
 *   57-64  from application to offer | which sites answer
 *   66-74  activity, last 13 weeks
 *   76-85  match score | latest answers
 */
import { A, ANSWERED, CHIPS, STATUSES, hex } from './layout'

type Cell = string | number
export interface Block {
  range: string
  values: Cell[][]
}

export const DASH = 'Dashboard'
export const DASH_ROWS = 100
export const DASH_COLS = 40
/** Pixel width of each content column (B:O). */
const COLW = 86
const ROWH = 21

/** Column letter for a 0-based index (0 → A, 26 → AA). */
export const colName = (c: number): string => (c >= 26 ? colName(Math.floor(c / 26) - 1) : '') + String.fromCharCode(65 + (c % 26))
const ref = (r: number, c: number) => `${colName(c)}${r + 1}`

// Columns, 0-based.
const B = 1
const I = 8
const O = 14
const HIDDEN = [16, 37] as const
const WEEK = 16 // Q:S week label, answered, no answer yet
const STAT = 20 // U:V status, count
const LATEST = 23 // X:AA company, title, status, date
const SITES = 33 // AH:AK site, applications, answered, interview

// Rows, 0-based.
const R = {
  title: 1,
  sub: 2,
  card: 4,
  insightsHead: 8,
  insights: 9,
  flowHead: 16,
  flow: 17,
  flowRows: 20,
  chartsHead: 38,
  charts: 39,
  chartRows: 16,
  t1Head: 56,
  heatHead: 65,
  t2Head: 75,
  foot: 87,
}

const C = {
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  hair: '#e1e0d9',
  faint: '#efeee9',
  card: '#f6f6f3',
  white: '#ffffff',
  banner: '#1a1a19',
  bannerInk: '#f0efec',
  bannerInk2: '#c3c2b7',
  blue: '#2a78d6',
  blueDark: '#1c5cab',
  blueLight: '#86b6ef',
  heatLow: '#eaf2fc',
  good: '#006300',
  critical: '#d03b3b',
  late: '#9a5b00',
}
const FONT = 'Inter'
const bar = (cell: string, color = C.blue) => `=IF(${cell}="","",SPARKLINE(${cell},{"charttype","bar";"max",1;"color1","${color}"}))`

/** Formulas over the Applications tab. */
export function metrics() {
  const date = A('Date applied')
  const status = A('Status')
  const changed = A('Last status change')
  const ids = A('Application ID')
  const isAns = `ISNUMBER(MATCH(${status},{${ANSWERED.map((s) => `"${s}"`).join(',')}},0))`
  const isIntv = `((${status}="Interview")+(${status}="Offer"))`
  // Rows with a company, less the header: rows added outside Zipply may have no
  // Application ID. The header row is text, so the other formulas skip it.
  const company = A('Company')
  const total = `MAX(COUNTA(${company})-1,0)`
  const hasRow = `(LEN(${company})>0)*(ROW(${company})>1)`
  const old = `(TODAY()-30)`
  return {
    date,
    status,
    changed,
    ids,
    company,
    title: A('Job title'),
    ats: A('ATS'),
    url: A('Posting URL'),
    score: A('Match score'),
    verdict: A('Verdict'),
    isAns,
    isIntv,
    total,
    hasRow,
    // SUMPRODUCT, not SUM(COUNTIF(…,{list})): Sheets counts only the list's first item without ARRAYFORMULA.
    ans: `SUMPRODUCT(--${isAns})`,
    intv: `(COUNTIF(${status},"Interview")+COUNTIF(${status},"Offer"))`,
    offers: `COUNTIF(${status},"Offer")`,
    waiting: `(COUNTIF(${status},"Applied")+COUNTIF(${status},"Received"))`,
    stale: `(COUNTIFS(${status},"Applied",${date},"<="&${old})+COUNTIFS(${status},"Received",${date},"<="&${old}))`,
    last7: `COUNTIFS(${date},">="&(TODAY()-6))`,
    prev7: `COUNTIFS(${date},">="&(TODAY()-13),${date},"<"&(TODAY()-6))`,
    last30: `COUNTIFS(${date},">="&(TODAY()-29))`,
    median: `MEDIAN(FILTER(IFERROR(${changed}-${date}),${isAns},ISNUMBER(${changed}),ISNUMBER(${date})))`,
  }
}

/** Monday of the week k weeks back (0 = this week). */
const weekStart = (k: number) => `(TODAY()-WEEKDAY(TODAY(),3)-${7 * k})`

/** Cells by position; written as runs of adjacent cells so no write covers a cell it doesn't set. */
export class Grid {
  constructor(private tab: string) {}
  cells = new Map<string, Cell>()
  put(r: number, c: number, v: Cell) {
    this.cells.set(`${r},${c}`, v)
  }
  row(r: number, c: number, vs: Cell[]) {
    vs.forEach((v, i) => this.put(r, c + i, v))
  }
  blocks(): Block[] {
    const byRow = new Map<number, number[]>()
    for (const k of this.cells.keys()) {
      const [r, c] = k.split(',').map(Number)
      byRow.set(r, [...(byRow.get(r) ?? []), c])
    }
    const out: Block[] = []
    for (const [r, cols] of [...byRow].sort((a, b) => a[0] - b[0])) {
      cols.sort((a, b) => a - b)
      let start = cols[0]
      let run: Cell[] = []
      cols.forEach((c, i) => {
        run.push(this.cells.get(`${r},${c}`)!)
        if (cols[i + 1] !== c + 1) {
          out.push({ range: `${this.tab}!${ref(r, start)}`, values: [run] })
          start = cols[i + 1]
          run = []
        }
      })
    }
    return out
  }
}

/** Where the merged cells go: [row0, row1, col0, col1), 0-based, end exclusive. */
type Box = [number, number, number, number]

interface Table {
  head: string
  /** Header labels with their widths in columns. */
  cols: [string, number][]
}

/** Table columns for each half. */
const LEFT: Record<string, Table> = {
  funnel: { head: 'From application to offer', cols: [['Stage', 2], ['Count', 1], ['Of applied', 1], ['', 3]] },
  score: { head: 'Does the match score predict answers?', cols: [['Match score', 2], ['Applied', 1], ['Answered', 1], ['Interview', 1], ['', 2]] },
}
const RIGHT: Record<string, Table> = {
  sites: { head: 'Which sites answer', cols: [['Site', 2], ['Applied', 1], ['Answered', 1], ['Interview', 1], ['', 2]] },
  latest: { head: 'Latest answers', cols: [['Company', 2], ['Role', 3], ['Status', 1], ['Date', 1]] },
}

/** Start column of each column of a table. */
function starts(t: Table, c0: number): number[] {
  const out: number[] = []
  let c = c0
  for (const [, w] of t.cols) {
    out.push(c)
    c += w
  }
  return out
}

/** Cards: [label, value formula, note formula, number format]. */
function cards(m: ReturnType<typeof metrics>): [string, string, string, string][] {
  return [
    ['Applications', `=${m.total}`, `=IF(COUNT(${m.date})=0,"none yet","since "&TEXT(MIN(${m.date}),"mmm d"))`, '0'],
    [
      'Last 7 days',
      `=${m.last7}`,
      `=LET(d,${m.last7}-${m.prev7},IF(d>0,"▲ "&d&" vs the week before",IF(d<0,"▼ "&-d&" vs the week before","same as the week before")))`,
      '0',
    ],
    ['Answered', `=IFERROR(${m.ans}/${m.total},0)`, `=${m.ans}&" of "&${m.total}&" applications"`, '0%'],
    ['Interviews', `=${m.intv}`, `=IF(${m.total}=0,"",TEXT(${m.intv}/${m.total},"0%")&" of applications")`, '0'],
    ['Offers', `=${m.offers}`, `=COUNTIF(${m.status},"Rejected")&" rejections"`, '0'],
    ['Days to an answer', `=IFERROR(${m.median},"–")`, `="median, from applying"`, '0'],
    ['Waiting', `=${m.waiting}`, `=${m.stale}&" for 30+ days"`, '0'],
  ]
}

/** One sentence each, written by formulas. */
function insights(m: ReturnType<typeof metrics>): string[] {
  const latest = (i: number) => ref(1, LATEST + i)
  const sites = `${ref(1, SITES)}:${colName(SITES + 3)}`
  const siteCol = (i: number) => `${ref(1, SITES + i)}:${colName(SITES + i)}`
  return [
    `=IF(${m.total}=0,"No applications yet. Apply with Zipply open and they show up here.",LET(w,${m.last7},p,${m.prev7},"You sent "&w&IF(w=1," application"," applications")&" in the last 7 days"&IF(p=0,"",IF(w>p,", up from "&p,IF(w<p,", down from "&p,", the same as"))&" the week before")&", and about "&TEXT(${m.last30}/30*7,"0.0")&" a week over the last 30 days."))`,
    `=IF(${m.total}=0,"",LET(a,${m.ans},i,${m.intv},o,${m.offers},"Companies answered "&a&" of your "&${m.total}&" applications ("&TEXT(a/${m.total},"0%")&"). "&IF(i=0,"None has reached an interview yet.",i&IF(i=1," has"," have")&" reached the interview stage"&IF(o>0,", and "&o&IF(o=1," became an offer"," became offers"),"")&".")))`,
    `=IFERROR(LET(t,SORT(FILTER(${sites},${siteCol(1)}>=3,${siteCol(0)}<>"Other"),3,FALSE,2,FALSE),n,ROWS(t),IF(INDEX(t,1,3)=0,"No site has answered yet among those you've used 3+ times.","Applications through "&INDEX(t,1,1)&" get answered most often ("&TEXT(INDEX(t,1,3),"0%")&" of "&INDEX(t,1,2)&")"&IF(n>1,", "&INDEX(t,n,1)&" least ("&TEXT(INDEX(t,n,3),"0%")&" of "&INDEX(t,n,2)&")","")&".")),"Once you've used a site 3+ times, this says which ones answer most.")`,
    `=LET(s,${m.score},hi,COUNTIFS(s,">=70"),lo,COUNTIFS(s,"<70"),IF(OR(hi<3,lo<3),"With 3+ applications on each side of a 70 match score, this compares how often each gets answered.",LET(h,SUMPRODUCT(ISNUMBER(s)*(s>=70)*${m.isAns})/hi,l,SUMPRODUCT(ISNUMBER(s)*(s<70)*${m.isAns})/lo,"Jobs with a match score of 70+ were answered "&TEXT(h,"0%")&" of the time, against "&TEXT(l,"0%")&" below 70"&IF(h>l,", so the higher scores have paid off.",IF(h<l,", so lower-scored jobs have done better so far.",".")))))`,
    `=LET(n,${m.stale},IF(n=0,"Nothing has gone 30+ days without an answer.",n&IF(n=1," application has"," applications have")&" gone 30+ days without an answer: worth a follow-up, or letting go."))`,
    `=IF(${latest(0)}="","No answers yet. Zipply reads your Gmail and updates statuses as replies arrive.","Latest answer: "&TRIM(${latest(0)})&IF(${latest(1)}="",""," ("&TRIM(${latest(1)})&")")&" "&SWITCH(${latest(2)},"Rejected","passed","Interview","asked to interview you","Assessment","sent an assessment","Offer","made you an offer","replied")&" on "&TEXT(${latest(3)},"mmm d")&".")`,
  ]
}

/**
 * The Sankey: Sheets has no such chart, so QuickChart draws it from an IMAGE()
 * formula. Only the counts leave Google, in the chart's address; it redraws
 * whenever they change. Applied flows to how far each application got (heard
 * back, an automatic reply only, no reply yet, ghosted), and heard back on to the answer.
 */
const SANKEY: { key: string; from: string; label: string; count: (m: ReturnType<typeof metrics>) => string; color: string }[] = [
  { key: 'h', from: 'a', label: 'Heard back', count: (m) => m.ans, color: '#1c5cab' },
  { key: 'r', from: 'a', label: 'Auto-reply only', count: (m) => `COUNTIF(${m.status},"Received")`, color: '#86b6ef' },
  { key: 'n', from: 'a', label: 'No reply', count: (m) => `COUNTIF(${m.status},"Applied")`, color: '#c3c2b7' },
  { key: 'g', from: 'a', label: 'Ghosted', count: (m) => `COUNTIF(${m.status},"Ghosted")`, color: '#898781' },
  { key: 'x', from: 'h', label: 'Rejected', count: (m) => `COUNTIF(${m.status},"Rejected")`, color: '#d03b3b' },
  { key: 's', from: 'h', label: 'Assessment', count: (m) => `COUNTIF(${m.status},"Assessment")`, color: '#eda100' },
  { key: 'i', from: 'h', label: 'Interview', count: (m) => `COUNTIF(${m.status},"Interview")`, color: '#6250d6' },
  { key: 'o', from: 'h', label: 'Offer', count: (m) => `COUNTIF(${m.status},"Offer")`, color: '#0ca30c' },
]
const SANKEY_W = 14 * COLW
const SANKEY_ROWH = 22

function sankeyImage(m: ReturnType<typeof metrics>): string {
  const colors = `({a:'#52514e',${SANKEY.map((s) => `${s.key}:'${s.color}'`).join(',')}})`
  const columns = `{a:0,${SANKEY.map((s) => `${s.key}:${s.from === 'a' ? 1 : 2}`).join(',')}}`
  // A flow of 0 is left out: the library draws it as a stray line.
  const flows = SANKEY.map((s) => `IF(${s.count(m)}>0,"{from:'${s.from}',to:'${s.key}',flow:"&${s.count(m)}&"},","")`).join('&')
  const share = (f: string) => `TEXT(${f}/MAX(${m.total},1),"0%")`
  const labels = SANKEY.map((s) => `"${s.key}:'${s.label} "&${s.count(m)}&" ("&${share(s.count(m))}&")',"`).join('&')
  const config = [
    `"{type:'sankey',data:{datasets:[{data:["`,
    flows,
    `"],colorMode:'to',colorFrom:(c)=>${colors}[c.dataset.data[c.dataIndex].from],colorTo:(c)=>${colors}[c.dataset.data[c.dataIndex].to],column:${columns},labels:{a:'Applied "&${m.total}&"',"`,
    labels,
    `"},size:'max',nodeWidth:14,nodePadding:18,font:{size:15},color:'#0b0b0b'}]},options:{layout:{padding:12}}}"`,
  ].join('&')
  return `=IMAGE("https://quickchart.io/chart?v=3&bkg=white&w=${SANKEY_W}&h=${R.flowRows * SANKEY_ROWH}&c="&ENCODEURL(${config}),1)`
}

/** Dashboard cells, written with USER_ENTERED so the formulas evaluate. */
export function dashboardData(): Block[] {
  const m = metrics()
  const g = new Grid(DASH)

  g.put(R.title, B, 'Job search')
  g.put(R.sub, B, `="As of "&TEXT(TODAY(),"dddd, mmmm d")&"  ·  "&${m.total}&" applications tracked by Zipply"`)

  cards(m).forEach(([label, value, note], k) => {
    g.put(R.card, B + 2 * k, label)
    g.put(R.card + 1, B + 2 * k, value)
    g.put(R.card + 2, B + 2 * k, note)
  })

  g.put(R.insightsHead, B, 'What stands out')
  insights(m).forEach((f, i) => g.put(R.insights + i, B, f))

  g.put(R.flowHead, B, 'Where your applications went')
  g.put(R.flow, B, sankeyImage(m))

  g.put(R.chartsHead, B, 'Applications per week, by whether they were answered')
  g.put(R.chartsHead, I, 'Where things stand')

  // Chart data, hidden: 13 weeks, oldest first.
  g.row(0, WEEK, ['Week of', 'Got an answer', 'No answer yet'])
  for (let k = 12, r = 1; k >= 0; k--, r++) {
    const s = weekStart(k)
    const answered = `SUMPRODUCT((${m.date}>=${s})*(${m.date}<${s}+7)*${m.isAns})`
    g.row(r, WEEK, [`=TEXT(${s},"mmm d")`, `=${answered}`, `=COUNTIFS(${m.date},">="&${s},${m.date},"<"&${s}+7)-${answered}`])
  }
  g.row(0, STAT, ['Status', 'Applications'])
  STATUSES.forEach((s, i) => g.row(1 + i, STAT, [s === 'Applied' ? 'No reply yet' : s, `=COUNTIF(${m.status},"${s}")`]))
  g.row(0, LATEST, ['Company', 'Role', 'Status', 'Date'])
  g.put(1, LATEST, `=IFERROR(SORTN(FILTER({${m.company},${m.title},${m.status},${m.changed}},${m.isAns},ISNUMBER(${m.changed})),8,0,4,FALSE),"")`)
  g.row(0, SITES, ['Site', 'Applied', 'Answered', 'Interview'])
  const per = (cond: string) => `MAP(u,LAMBDA(x,SUMPRODUCT((${m.ats}=x)*${cond})/COUNTIF(${m.ats},x)))`
  g.put(
    1,
    SITES,
    `=IFERROR(LET(s,FILTER(${m.ats},ROW(${m.ats})>1,${m.ats}<>""),u,UNIQUE(s),SORT(HSTACK(u,MAP(u,LAMBDA(x,COUNTIF(s,x))),${per(m.isAns)},${per(m.isIntv)}),2,FALSE,1,TRUE)),"")`,
  )

  // Tables, each with a header row under its title.
  const header = (t: Table, r: number, c0: number) => {
    g.put(r, c0, t.head)
    const s = starts(t, c0)
    t.cols.forEach(([label], i) => label && g.put(r + 1, s[i], label))
    return s
  }

  // From application to offer.
  {
    const s = header(LEFT.funnel, R.t1Head, B)
    const steps: [string, string][] = [
      ['Applied', m.total],
      ['Heard back', m.ans],
      ['Interview stage', m.intv],
      ['Offer', m.offers],
    ]
    steps.forEach(([label, f], i) => {
      const r = R.t1Head + 2 + i
      g.put(r, s[0], label)
      g.put(r, s[1], `=${f}`)
      g.put(r, s[2], `=IFERROR(${ref(r, s[1])}/${m.total},0)`)
      g.put(r, s[3], bar(ref(r, s[2])))
    })
  }
  // Which sites answer: the top six.
  {
    const s = header(RIGHT.sites, R.t1Head, I)
    for (let i = 0; i < 6; i++) {
      const r = R.t1Head + 2 + i
      const h = (j: number) => ref(1 + i, SITES + j)
      g.put(r, s[0], `=${h(0)}`)
      g.put(r, s[1], `=IF(${h(0)}="","",${h(1)})`)
      g.put(r, s[2], `=IF(${h(0)}="","",${h(2)})`)
      g.put(r, s[3], `=IF(${h(0)}="","",${h(3)})`)
      g.put(r, s[4], bar(ref(r, s[2])))
    }
  }

  // Activity: 13 weeks across, Monday to Sunday down.
  g.put(R.heatHead, B, 'When you apply, last 13 weeks')
  for (let k = 12, c = B + 1; k >= 0; k--, c++) g.put(R.heatHead + 1, c, `=${weekStart(k)}`)
  ;['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d, di) => {
    const r = R.heatHead + 2 + di
    g.put(r, B, d)
    for (let c = B + 1; c <= O; c++) g.put(r, c, `=COUNTIF(${m.date},${colName(c)}$${R.heatHead + 2}+${di})`)
  })

  // Match score, against answers.
  const outcomeRows = (t: Table, c0: number, rows: [string, string][]) => {
    const s = header(t, R.t2Head, c0)
    rows.forEach(([label, cond], i) => {
      const r = R.t2Head + 2 + i
      const n = ref(r, s[1])
      g.put(r, s[0], label)
      g.put(r, s[1], `=SUMPRODUCT(${cond})`)
      g.put(r, s[2], `=IF(${n}=0,"",SUMPRODUCT(${cond}*${m.isAns})/${n})`)
      g.put(r, s[3], `=IF(${n}=0,"",SUMPRODUCT(${cond}*${m.isIntv})/${n})`)
      g.put(r, s[4], bar(ref(r, s[2])))
    })
  }
  const scored = `ISNUMBER(${m.score})`
  outcomeRows(LEFT.score, B, [
    ['80 and up', `${scored}*(${m.score}>=80)`],
    ['60 to 79', `${scored}*(${m.score}>=60)*(${m.score}<80)`],
    ['Below 60', `${scored}*(${m.score}<60)`],
    ['Not scored', `${m.hasRow}*NOT(${scored})`],
  ])

  // Latest answers, from the hidden list.
  {
    const sl = header(RIGHT.latest, R.t2Head, I)
    for (let i = 0; i < 8; i++) {
      const r = R.t2Head + 2 + i
      const l = (j: number) => ref(1 + i, LATEST + j)
      sl.forEach((c, j) => g.put(r, c, `=${l(j)}`))
    }
  }

  g.put(
    R.foot,
    B,
    "Zipply keeps this tab up to date from the Applications tab. Answered means an assessment, interview, offer or rejection; an automatic “we received it” doesn't count.",
  )
  return g.blocks()
}

/**
 * The same cells as updateCells requests, so they go in the batch that creates
 * the tab: its charts then start with data (Sheets dropped the series colors of
 * charts made over empty cells).
 */
export function dashboardCells(sheetId: number): object[] {
  return cellRequests(dashboardData(), sheetId)
}

/** Blocks of cells as updateCells requests for one tab. */
export function cellRequests(blocks: Block[], sheetId: number): object[] {
  return blocks.map(({ range, values }) => {
    const [, col, row] = range.match(/!([A-Z]+)(\d+)$/)!
    const columnIndex = [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
    return {
      updateCells: {
        start: { sheetId, rowIndex: Number(row) - 1, columnIndex },
        rows: values.map((r) => ({
          values: r.map((v) => ({
            userEnteredValue: typeof v === 'number' ? { numberValue: v } : v.startsWith('=') ? { formulaValue: v } : { stringValue: v },
          })),
        })),
        fields: 'userEnteredValue',
      },
    }
  })
}

/**
 * The spreadsheet's theme. Sheets draws charts in the theme's accent colors and
 * ignored the series colors set through the API, so the palette goes here:
 * accent 1 and 2 are the weekly chart's two blues, the rest the categorical order.
 */
export function themeRequest(): object {
  const theme: [string, string][] = [
    ['TEXT', '#000000'],
    ['BACKGROUND', '#ffffff'],
    ['ACCENT1', C.blueDark],
    ['ACCENT2', C.blueLight],
    ['ACCENT3', '#eb6834'],
    ['ACCENT4', '#1baf7a'],
    ['ACCENT5', '#eda100'],
    ['ACCENT6', '#6250d6'],
    ['LINK', '#1155cc'],
  ]
  return {
    updateSpreadsheetProperties: {
      properties: {
        spreadsheetTheme: { primaryFontFamily: 'Arial', themeColors: theme.map(([colorType, h]) => ({ colorType, color: { rgbColor: hex(h) } })) },
      },
      fields: 'spreadsheetTheme',
    },
  }
}

/** Formatting, merges and charts for a fresh Dashboard tab (Sheets batchUpdate requests). */
export function dashboardRequests(sheetId: number): object[] {
  const grid = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 })
  const out: object[] = []
  const merges: Box[] = []
  const merge = (...b: Box) => merges.push(b)

  /** Field paths for a partial format, so later styles don't clear earlier ones. */
  const paths = (o: object, pre: string): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object' && !('red' in v) && k !== 'padding' && k !== 'numberFormat' ? paths(v, `${pre}.${k}`) : [`${pre}.${k}`],
    )
  const style = (b: Box, f: Record<string, unknown>) =>
    out.push({ repeatCell: { range: grid(...b), cell: { userEnteredFormat: f }, fields: paths(f, 'userEnteredFormat').join(',') } })
  const text = (o: Record<string, unknown>) => ({ textFormat: o })
  const line = (color: string, s = 'SOLID') => ({ style: s, color: hex(color) })
  const borders = (b: Box, o: Record<string, object>) => out.push({ updateBorders: { range: grid(...b), ...o } })
  const pct = { numberFormat: { type: 'PERCENT', pattern: '0%' } }

  // Sheet shape: gutters, equal content columns, chart data hidden.
  const width = (c0: number, c1: number, px: number) =>
    out.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: c0, endIndex: c1 }, properties: { pixelSize: px }, fields: 'pixelSize' } })
  const height = (r0: number, r1: number, px: number) =>
    out.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: r0, endIndex: r1 }, properties: { pixelSize: px }, fields: 'pixelSize' } })
  width(0, 1, 20)
  width(B, O + 1, COLW)
  width(O + 1, O + 2, 20)
  out.push({
    updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: HIDDEN[0], endIndex: HIDDEN[1] }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' },
  })
  height(0, 1, 10)
  height(R.title, R.title + 1, 46)
  height(R.sub, R.sub + 1, 26)
  height(R.sub + 1, R.sub + 2, 14)
  height(R.card, R.card + 1, 24)
  height(R.card + 1, R.card + 2, 40)
  height(R.card + 2, R.card + 3, 24)
  height(R.charts, R.charts + R.chartRows, ROWH)

  // Base text for the whole page.
  style([0, DASH_ROWS, 0, O + 2], { verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP', ...text({ fontFamily: FONT, fontSize: 10, foregroundColor: hex(C.ink) }) })

  // Banner.
  merge(R.title, R.title + 1, B, O + 1)
  merge(R.sub, R.sub + 1, B, O + 1)
  style([R.title, R.sub + 1, B, O + 1], { backgroundColor: hex(C.banner), padding: { left: 14 } })
  style([R.title, R.title + 1, B, O + 1], { verticalAlignment: 'BOTTOM', ...text({ fontSize: 20, bold: true, foregroundColor: hex(C.bannerInk) }) })
  style([R.sub, R.sub + 1, B, O + 1], { verticalAlignment: 'TOP', ...text({ fontSize: 10, foregroundColor: hex(C.bannerInk2) }) })

  // Cards: a blue rule on top, white gaps between.
  for (let k = 0; k < 7; k++) {
    const c = B + 2 * k
    for (let r = R.card; r < R.card + 3; r++) merge(r, r + 1, c, c + 2)
    borders([R.card, R.card + 3, c, c + 2], { top: line(C.blue, 'SOLID_THICK'), left: line(C.white, 'SOLID_THICK'), right: line(C.white, 'SOLID_THICK') })
  }
  style([R.card, R.card + 3, B, O + 1], { backgroundColor: hex(C.card), horizontalAlignment: 'LEFT', padding: { left: 10 } })
  style([R.card, R.card + 1, B, O + 1], { verticalAlignment: 'BOTTOM', ...text({ fontSize: 9, bold: true, foregroundColor: hex(C.ink2) }) })
  style([R.card + 1, R.card + 2, B, O + 1], text({ fontSize: 22, bold: true }))
  style([R.card + 2, R.card + 3, B, O + 1], { verticalAlignment: 'TOP', ...text({ fontSize: 9, foregroundColor: hex(C.muted) }) })
  cards(metrics()).forEach(([, , , pattern], k) => style([R.card + 1, R.card + 2, B + 2 * k, B + 2 * k + 1], { numberFormat: { type: pattern.includes('%') ? 'PERCENT' : 'NUMBER', pattern } }))

  // Section titles: bold, with a hairline under.
  const section = (r: number, c0: number, c1: number) => {
    merge(r, r + 1, c0, c1)
    height(r, r + 1, 32)
    style([r, r + 1, c0, c1], { verticalAlignment: 'BOTTOM', ...text({ fontSize: 12, bold: true }) })
    borders([r, r + 1, c0, c1], { bottom: line(C.hair) })
  }
  const halves = (r: number) => {
    section(r, B, I - 1)
    section(r, I, O + 1)
  }
  section(R.insightsHead, B, O + 1)
  section(R.flowHead, B, O + 1)
  merge(R.flow, R.flow + R.flowRows, B, O + 1)
  height(R.flow, R.flow + R.flowRows, SANKEY_ROWH)
  halves(R.chartsHead)
  halves(R.t1Head)
  section(R.heatHead, B, O + 1)
  halves(R.t2Head)

  // What stands out: one sentence per line.
  for (let i = 0; i < 6; i++) merge(R.insights + i, R.insights + i + 1, B, O + 1)
  height(R.insights, R.insights + 6, 24)
  style([R.insights, R.insights + 6, B, O + 1], { padding: { left: 4 }, ...text({ fontSize: 10, foregroundColor: hex(C.ink2) }) })

  // Tables: merged columns, a muted header, hairlines between rows.
  const table = (t: Table, r0: number, c0: number, rows: number) => {
    const s = starts(t, c0)
    const end = c0 + t.cols.reduce((n, [, w]) => n + w, 0)
    for (let r = r0 + 1; r <= r0 + rows + 1; r++) t.cols.forEach(([, w], i) => w > 1 && merge(r, r + 1, s[i], s[i] + w))
    height(r0 + 1, r0 + rows + 2, 24)
    style([r0 + 1, r0 + 2, c0, end], text({ fontSize: 9, bold: true, foregroundColor: hex(C.muted) }))
    borders([r0 + 2, r0 + rows + 2, c0, end], { innerHorizontal: line(C.faint), bottom: line(C.faint) })
    // Numbers right-aligned under right-aligned headers.
    t.cols.forEach(([label], i) => {
      if (i === 0 || !label || label === 'Role' || label === 'Company' || label === 'Status') return
      style([r0 + 1, r0 + rows + 2, s[i], s[i] + 1], { horizontalAlignment: 'RIGHT' })
    })
    return s
  }
  {
    const s = table(LEFT.funnel, R.t1Head, B, 4)
    style([R.t1Head + 2, R.t1Head + 6, s[2], s[2] + 1], pct)
  }
  {
    const s = table(RIGHT.sites, R.t1Head, I, 6)
    style([R.t1Head + 2, R.t1Head + 8, s[2], s[4]], pct)
  }
  {
    const s = table(LEFT.score, R.t2Head, B, 4)
    style([R.t2Head + 2, R.t2Head + 6, s[2], s[4]], pct)
  }
  const latest = table(RIGHT.latest, R.t2Head, I, 8)
  style([R.t2Head + 2, R.t2Head + 10, latest[3], latest[3] + 1], { numberFormat: { type: 'DATE', pattern: 'mmm d' } })
  style([R.t2Head + 2, R.t2Head + 10, latest[2], latest[2] + 1], { horizontalAlignment: 'CENTER', ...text({ fontSize: 9, bold: true }) })

  // Activity calendar: tiles with white gaps, zeros left blank.
  const heat: Box = [R.heatHead + 2, R.heatHead + 9, B + 1, O + 1]
  height(R.heatHead + 1, R.heatHead + 2, 22)
  height(heat[0], heat[1], 24)
  style([R.heatHead + 1, R.heatHead + 2, B + 1, O + 1], {
    horizontalAlignment: 'CENTER',
    numberFormat: { type: 'DATE', pattern: 'mmm d' },
    ...text({ fontSize: 8, foregroundColor: hex(C.muted) }),
  })
  style([heat[0], heat[1], B, B + 1], text({ fontSize: 9, foregroundColor: hex(C.muted) }))
  style(heat, { horizontalAlignment: 'CENTER', numberFormat: { type: 'NUMBER', pattern: '0;-0;;@' }, ...text({ fontSize: 9 }) })
  borders(heat, { innerHorizontal: line(C.white, 'SOLID_THICK'), innerVertical: line(C.white, 'SOLID_THICK') })

  // Footnote.
  merge(R.foot, R.foot + 1, B, O + 1)
  style([R.foot, R.foot + 1, B, O + 1], text({ fontSize: 8, italic: true, foregroundColor: hex(C.muted) }))

  for (const [r0, r1, c0, c1] of merges) out.push({ mergeCells: { range: grid(r0, r1, c0, c1), mergeType: 'MERGE_ALL' } })

  // Conditional formats, first match wins.
  const rules: object[] = []
  const when = (b: Box, condition: object, format: object) => rules.push({ ranges: [grid(...b)], booleanRule: { condition, format } })
  const trend = ref(R.card + 2, B + 2)
  when([R.card + 2, R.card + 3, B + 2, B + 4], { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=LEFT(${trend},1)="▲"` }] }, { textFormat: { foregroundColor: hex(C.good) } })
  when([R.card + 2, R.card + 3, B + 2, B + 4], { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=LEFT(${trend},1)="▼"` }] }, { textFormat: { foregroundColor: hex(C.critical) } })
  const chips: Box = [R.t2Head + 2, R.t2Head + 10, latest[2], latest[2] + 1]
  for (const [s, bg, fg] of CHIPS) when(chips, { type: 'TEXT_EQ', values: [{ userEnteredValue: s }] }, { backgroundColor: hex(bg), textFormat: { foregroundColor: hex(fg) } })
  // Days still to come this week stay white.
  const firstDay = `${colName(B + 1)}$${R.heatHead + 2}+ROW()-${heat[0] + 1}`
  when(heat, { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${firstDay}>TODAY()` }] }, { backgroundColor: hex(C.white) })
  rules.forEach((rule, index) => out.push({ addConditionalFormatRule: { index, rule } }))
  out.push({
    addConditionalFormatRule: {
      index: rules.length,
      rule: {
        ranges: [grid(...heat)],
        gradientRule: {
          minpoint: { color: hex(C.heatLow), type: 'NUMBER', value: '0' },
          maxpoint: { color: hex(C.blue), type: 'MAX' },
        },
      },
    },
  })

  // Charts, side by side under their titles.
  const src = (r0: number, r1: number, c: number) => ({ sourceRange: { sources: [grid(r0, r1, c, c + 1)] } })
  const place = (c: number) => ({
    overlayPosition: { anchorCell: { sheetId, rowIndex: R.charts, columnIndex: c }, offsetXPixels: 2, offsetYPixels: 6, widthPixels: 7 * COLW - 10, heightPixels: R.chartRows * ROWH - 12 },
  })
  const look = { fontName: FONT, backgroundColor: hex(C.white), hiddenDimensionStrategy: 'SHOW_ALL' }
  out.push({
    addChart: {
      chart: {
        spec: {
          ...look,
          basicChart: {
            chartType: 'COLUMN',
            stackedType: 'STACKED',
            legendPosition: 'TOP_LEGEND',
            headerCount: 1,
            axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }],
            domains: [{ domain: src(0, 14, WEEK) }],
            series: [
              { series: src(0, 14, WEEK + 1), targetAxis: 'LEFT_AXIS', colorStyle: { rgbColor: hex(C.blueDark) } },
              { series: src(0, 14, WEEK + 2), targetAxis: 'LEFT_AXIS', colorStyle: { rgbColor: hex(C.blueLight) } },
            ],
          },
        },
        position: place(B),
      },
    },
  })
  out.push({
    addChart: {
      chart: {
        spec: {
          ...look,
          basicChart: {
            chartType: 'BAR',
            legendPosition: 'NO_LEGEND',
            headerCount: 1,
            axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }],
            domains: [{ domain: src(0, 1 + STATUSES.length, STAT) }],
            series: [{ series: src(0, 1 + STATUSES.length, STAT + 1), targetAxis: 'BOTTOM_AXIS', colorStyle: { rgbColor: hex(C.blue) } }],
          },
        },
        position: place(I),
      },
    },
  })
  return out
}
