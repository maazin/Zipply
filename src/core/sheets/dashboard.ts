/*
 * The Dashboard tab: plain spreadsheet formulas over the Applications tab, so it
 * keeps itself up to date with no code. Activity calendar and last-7/30-day
 * counts adapted from JobSync (https://github.com/Gsync/jobsync)
 * src/actions/dashboard, MIT; staleness check from ai-job-search's gmail-sync (MIT).
 *
 * Built on the columns every row has (company, status, dates); the ones only
 * Zipply's own rows fill in (site, match score, verdict) are too sparse to
 * compare by.
 *
 * Layout (content in B:O, 14 columns; chart and list data in hidden columns Q:AJ):
 *   2-3    banner
 *   5-7    seven cards
 *   9-14   what stands out (sentences written by formulas)
 *   16-25  to do: open assessments and interviews | follow up this week
 *   27-47  where your applications went (a Sankey drawn by QuickChart)
 *   49-65  applications per week | waiting, by days since applying (charts)
 *   67-72  how each month's applications did
 *   74-83  how long answers take | latest answers
 */
import { A, ANSWERED, CHIPS, hex } from './layout'

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
const AGE = 20 // U:V days since applying, applications waiting
const LATEST = 23 // X:AA company, role, status, date
const OPEN = 28 // AC:AF company, role, stage, since
const FOLLOW = 33 // AH:AJ company, role, date applied

// Rows, 0-based.
const R = {
  title: 1,
  sub: 2,
  card: 4,
  insightsHead: 8,
  insights: 9,
  todoHead: 15,
  flowHead: 26,
  flow: 27,
  flowRows: 20,
  chartsHead: 48,
  charts: 49,
  chartRows: 16,
  monthsHead: 66,
  timingHead: 73,
  foot: 85,
}
/** Rows in each to-do list and in the latest answers. */
const LIST = 8
const INSIGHTS = 5

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
  blueWash: '#dfe7f3',
  good: '#006300',
  critical: '#d03b3b',
  late: '#9a5b00',
}
const FONT = 'Inter'

/** Formulas over the Applications tab. */
export function metrics() {
  const date = A('Date applied')
  const status = A('Status')
  const changed = A('Last status change')
  const first = A('First reply')
  const isAns = `ISNUMBER(MATCH(${status},{${ANSWERED.map((s) => `"${s}"`).join(',')}},0))`
  const isNext = `((${status}="Assessment")+(${status}="Interview")+(${status}="Offer"))`
  const isWaiting = `((${status}="Applied")+(${status}="Received"))`
  // Rows with a company, less the header: rows added outside Zipply may have no
  // Application ID. The header row is text, so the other formulas skip it.
  const company = A('Company')
  const total = `MAX(COUNTA(${company})-1,0)`
  const dated = `ISNUMBER(${date})`
  /** Applied/Received rows by days since applying, from a (inclusive) to b (exclusive). */
  const waitingAged = (a: number, b?: number) =>
    ['Applied', 'Received']
      .map((s) => `COUNTIFS(${status},"${s}",${date},"<="&(TODAY()-${a})${b == null ? '' : `,${date},">"&(TODAY()-${b})`})`)
      .join('+')
  // Days from applying to the last change, for rows with both dates (negative ones are bad data).
  const daysTo = (cond: string, end = changed) =>
    `MEDIAN(FILTER(IFERROR(${end}-${date}),${cond},ISNUMBER(${end}),${dated},IFERROR(${end}-${date},-1)>=0))`
  // Applications three weeks or older: young ones haven't had time to be answered.
  const mature = `(${date}<=TODAY()-21)*${dated}`
  // When a row last moved: its last change, else the date applied, as a number
  // (rows typed in by hand can hold dates as text, which sort above every number).
  const since = `IFERROR(${changed}*1,IFERROR(${date}*1,""))`
  const recent = `IFERROR((IFERROR(${changed}*1,${date}*1)>=TODAY()-30)*1,0)`
  return {
    date,
    status,
    changed,
    first,
    company,
    title: A('Job title'),
    isAns,
    isNext,
    isWaiting,
    total,
    // SUMPRODUCT, not SUM(COUNTIF(…,{list})): Sheets counts only the list's first item without ARRAYFORMULA.
    ans: `SUMPRODUCT(--${isAns})`,
    next: `(COUNTIF(${status},"Assessment")+COUNTIF(${status},"Interview")+COUNTIF(${status},"Offer"))`,
    nextRecent: `SUMPRODUCT(${isNext}*${recent})`,
    since,
    rejected: `COUNTIF(${status},"Rejected")`,
    matureN: `SUMPRODUCT(${mature})`,
    matureAns: `SUMPRODUCT(${mature}*${isAns})`,
    last7: `COUNTIFS(${date},">="&(TODAY()-6))`,
    avg4: `(COUNTIFS(${date},">="&(TODAY()-27))/4)`,
    followDue: `(${waitingAged(7, 22)})`,
    waitingLive: `(${waitingAged(0, 60)})`,
    ghosted: `(COUNTIF(${status},"Ghosted")+${waitingAged(60)})`,
    toReject: daysTo(`${status}="Rejected"`),
    toNext: daysTo(isNext),
    toAny: daysTo(isAns),
    // Of answers with both dates, the share that came more than two weeks after applying.
    lateShare: `SUMPRODUCT(IFERROR(${isAns}*ISNUMBER(${changed})*${dated}*((${changed}-${date})>14),0))/MAX(1,SUMPRODUCT(IFERROR(${isAns}*ISNUMBER(${changed})*${dated}*((${changed}-${date})>=0),0)))`,
    noRole: `SUMPRODUCT((LEN(${company})>0)*(ROW(${company})>1)*(LEN(${A('Job title')})=0))`,
  }
}
type M = ReturnType<typeof metrics>

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
  /** A title, or a formula for one. */
  head: string
  /** Header labels with their widths in columns. */
  cols: [string, number][]
}

const TABLES: Record<string, Table> = {
  open: { head: '', cols: [['Company', 2], ['Role', 3], ['Stage', 1], ['Days in it', 1]] },
  follow: { head: '', cols: [['Company', 2], ['Role', 3], ['Applied', 1], ['Days', 1]] },
  months: {
    head: "How each month's applications did",
    cols: [['Applied in', 2], ['Applied', 1], ['Heard back', 1], ['Rejected', 1], ['Next step', 1], ['Waiting', 1], ['Ghosted', 1], ['', 6]],
  },
  timing: { head: 'How long answers take', cols: [['', 5], ['', 2]] },
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
function cards(m: M): [string, string, string, string][] {
  return [
    ['Applications', `=${m.total}`, `=IF(COUNT(${m.date})=0,"none yet","since "&TEXT(MIN(${m.date}),"mmm d"))`, '0'],
    [
      'Last 7 days',
      `=${m.last7}`,
      `=LET(d,ROUND(${m.last7}-${m.avg4}),IF(d>0,"▲ "&d&" over weekly avg",IF(d<0,"▼ "&-d&" under weekly avg","on weekly avg")))`,
      '0',
    ],
    ['Response rate', `=IFERROR(${m.matureAns}/${m.matureN},0)`, `="of "&${m.matureN}&" sent 3+ weeks ago"`, '0%'],
    ['In play', `=${m.nextRecent}`, `="moved in 30 days; "&(${m.next}-${m.nextRecent})&" older"`, '0'],
    ['Follow up', `=${m.followDue}`, `="7–21 days, no reply"`, '0'],
    ['Waiting', `=${m.waitingLive}`, `="under 60 days old"`, '0'],
    ['Ghosted', `=${m.ghosted}`, `="60+ days, silent"`, '0'],
  ]
}

/** One sentence each, written by formulas, each about something to do or to know. */
function insights(m: M): string[] {
  const open = (i: number) => ref(1, OPEN + i)
  return [
    `=IF(${m.total}=0,"No applications yet. Apply with Zipply open and they show up here.",LET(w,${m.last7},a,${m.avg4},"You sent "&w&IF(w=1," application"," applications")&" in the last 7 days, "&IF(w>=a,"at or above","below")&" your 4-week average of "&TEXT(a,"0")&" a week."))`,
    `=IF(${m.matureN}=0,"Response rates show once applications are 3 weeks old.",TEXT(${m.matureAns}/${m.matureN},"0%")&" of applications sent 3+ weeks ago got a real answer: "&${m.rejected}&" rejections and "&${m.next}&IF(${m.next}=1," next step"," next steps")&" so far.")`,
    `=IF(${open(0)}="","No assessments or interviews open right now.",LET(n,${m.nextRecent},o,${m.next}-n,IF(n=0,"No assessment or interview has moved in 30 days","Latest next step: "&TRIM(${open(0)})&" ("&LOWER(${open(2)})&", "&(TODAY()-${open(3)})&" days ago); "&n&" moved in the last 30 days")&IF(o>0,", and "&o&" older ones have likely closed.",".")))`,
    `=LET(f,${m.followDue},IF(f=0,"No applications are in the 7–21 day window where a follow-up helps.",f&IF(f=1," application is"," applications are")&" 7–21 days old with no reply: the window where a short follow-up still helps."))`,
    `=IFERROR("Rejections usually come within "&TEXT(${m.toReject},"0")&" days, and only "&TEXT(${m.lateShare},"0%")&" of answers came after two weeks of silence, so the "&${m.ghosted}&" applications past 60 days are safe to let go.","")`,
  ]
}

/**
 * The Sankey: Sheets has no such chart, so QuickChart draws it from an IMAGE()
 * formula. Only the counts leave Google, in the chart's address; it redraws
 * whenever they change. Applied flows to how far each application got (heard
 * back, an automatic reply only, no reply yet, ghosted), and heard back on to the answer.
 */
const SANKEY: { key: string; from: string; label: string; count: (m: M) => string; color: string }[] = [
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

function sankeyImage(m: M): string {
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

/** The first and last day of the month k months back (0 = this month). */
const monthStart = (k: number) => `(EOMONTH(TODAY(),-${k + 1})+1)`
const monthEnd = (k: number) => `EOMONTH(TODAY(),-${k})`
const MONTHS = 4

/** Dashboard cells, written with USER_ENTERED so the formulas evaluate. */
export function dashboardData(): Block[] {
  const m = metrics()
  const g = new Grid(DASH)

  g.put(R.title, B, 'Job search')
  g.put(R.sub, B, `="As of "&TEXT(TODAY(),"dddd, mmmm d")&"  ·  "&${m.total}&" applications"`)

  cards(m).forEach(([label, value, note], k) => {
    g.put(R.card, B + 2 * k, label)
    g.put(R.card + 1, B + 2 * k, value)
    g.put(R.card + 2, B + 2 * k, note)
  })

  g.put(R.insightsHead, B, 'What stands out')
  insights(m).forEach((f, i) => g.put(R.insights + i, B, f))

  // Hidden lists the tables and sentences read.
  g.row(0, LATEST, ['Company', 'Role', 'Status', 'Date'])
  g.put(1, LATEST, `=IFERROR(SORTN(FILTER({${m.company},${m.title},${m.status},${m.changed}},${m.isAns},ISNUMBER(${m.changed})),${LIST},0,4,FALSE),"")`)
  g.row(0, OPEN, ['Company', 'Role', 'Stage', 'Since'])
  // Newest first: those are the ones still worth acting on.
  g.put(1, OPEN, `=IFERROR(SORTN(FILTER({${m.company},${m.title},${m.status},${m.since}},${m.isNext}),${LIST},0,4,FALSE),"")`)
  g.row(0, FOLLOW, ['Company', 'Role', 'Applied'])
  g.put(1, FOLLOW, `=IFERROR(SORTN(FILTER({${m.company},${m.title},${m.date}},${m.isWaiting}*ISNUMBER(${m.date})*(${m.date}<=TODAY()-7)*(${m.date}>=TODAY()-21)),${LIST},0,3,TRUE),"")`)

  // Tables, each with a header row under its title.
  const header = (t: Table, r: number, c0: number, head = t.head) => {
    g.put(r, c0, head)
    const s = starts(t, c0)
    t.cols.forEach(([label], i) => label && g.put(r + 1, s[i], label))
    return s
  }
  const list = (t: Table, c0: number, from: number, cells: (h: (j: number) => string) => string[]) => {
    const s = starts(t, c0)
    for (let i = 0; i < LIST; i++) {
      const h = (j: number) => ref(1 + i, from + j)
      cells(h).forEach((f, j) => g.put(R.todoHead + 2 + i, s[j], f))
    }
  }

  // To do: what's open, and who to follow up with.
  header(TABLES.open, R.todoHead, B, `="Assessments and interviews, newest first  ·  "&${m.nextRecent}&" recent"`)
  list(TABLES.open, B, OPEN, (h) => [`=${h(0)}`, `=${h(1)}`, `=${h(2)}`, `=IF(${h(0)}="","",TODAY()-${h(3)})`])
  header(TABLES.follow, R.todoHead, I, `="Follow up this week: 7–21 days, no reply  ·  "&${m.followDue}`)
  list(TABLES.follow, I, FOLLOW, (h) => [`=${h(0)}`, `=${h(1)}`, `=${h(2)}`, `=IF(${h(0)}="","",TODAY()-${h(2)})`])

  g.put(R.flowHead, B, 'Where your applications went')
  g.put(R.flow, B, sankeyImage(m))

  g.put(R.chartsHead, B, 'Applications per week, by whether they were answered')
  g.put(R.chartsHead, I, 'Still waiting, by days since applying')

  // Chart data, hidden: 13 weeks, oldest first.
  g.row(0, WEEK, ['Week of', 'Got an answer', 'No answer yet'])
  for (let k = 12, r = 1; k >= 0; k--, r++) {
    const s = weekStart(k)
    const answered = `SUMPRODUCT((${m.date}>=${s})*(${m.date}<${s}+7)*${m.isAns})`
    g.row(r, WEEK, [`=TEXT(${s},"mmm d")`, `=${answered}`, `=COUNTIFS(${m.date},">="&${s},${m.date},"<"&${s}+7)-${answered}`])
  }
  const aged = (a: number, b?: number) =>
    ['Applied', 'Received'].map((s) => `COUNTIFS(${m.status},"${s}",${m.date},"<="&(TODAY()-${a})${b == null ? '' : `,${m.date},">"&(TODAY()-${b})`})`).join('+')
  const ages: [string, string][] = [
    ['0–6 days', aged(0, 7)],
    ['7–13 days', aged(7, 14)],
    ['14–29 days', aged(14, 30)],
    ['30–59 days', aged(30, 60)],
    ['60+ (ghosted)', m.ghosted],
  ]
  g.row(0, AGE, ['Waiting', 'Applications'])
  ages.forEach(([label, f], i) => g.row(1 + i, AGE, [label, `=${f}`]))

  // Each month's applications: how they've done so far, newest first.
  {
    const s = header(TABLES.months, R.monthsHead, B)
    const maxN = `MAX(${Array.from({ length: MONTHS }, (_, k) => ref(R.monthsHead + 2 + k, s[1])).join(',')},1)`
    for (let k = 0; k < MONTHS; k++) {
      const r = R.monthsHead + 2 + k
      const inMonth = `${m.date},">="&${monthStart(k)},${m.date},"<="&${monthEnd(k)}`
      const n = ref(r, s[1])
      const share = (f: string) => `=IF(${n}=0,"",(${f})/${n})`
      const count = (st: string) => `COUNTIFS(${inMonth},${m.status},"${st}")`
      g.put(r, s[0], `=TEXT(${monthStart(k)},"mmmm")`)
      g.put(r, s[1], `=COUNTIFS(${inMonth})`)
      g.put(r, s[2], share(`SUMPRODUCT((${m.date}>=${monthStart(k)})*(${m.date}<=${monthEnd(k)})*ISNUMBER(${m.date})*${m.isAns})`))
      g.put(r, s[3], share(count('Rejected')))
      g.put(r, s[4], share(`${count('Assessment')}+${count('Interview')}+${count('Offer')}`))
      g.put(r, s[5], share(`${count('Applied')}+${count('Received')}`))
      g.put(r, s[6], share(count('Ghosted')))
      // Bar: the month's volume against the busiest month, the dark part heard back.
      g.put(r, s[7], `=IF(${n}=0,"",SPARKLINE({${n}*${ref(r, s[2])},${n}*(1-${ref(r, s[2])})},{"charttype","bar";"max",${maxN};"color1","${C.blueDark}";"color2","${C.blueWash}"}))`)
    }
  }

  // How long answers take, beside the latest ones.
  {
    const s = header(TABLES.timing, R.timingHead, B)
    const rows: [string, string][] = [
      ['Median days to a rejection', `=IFERROR(TEXT(${m.toReject},"0")&" days","–")`],
      ['Median days to an assessment or interview', `=IFERROR(TEXT(${m.toNext},"0")&" days","–")`],
      ['Median days to any answer', `=IFERROR(TEXT(${m.toAny},"0")&" days","–")`],
      ['Answers that came after 2+ weeks', `=IFERROR(TEXT(${m.lateShare},"0%"),"–")`],
    ]
    rows.forEach(([label, f], i) => {
      g.put(R.timingHead + 2 + i, s[0], label)
      g.put(R.timingHead + 2 + i, s[1], f)
    })
  }
  {
    const s = header(TABLES.latest, R.timingHead, I)
    for (let i = 0; i < LIST; i++) s.forEach((c, j) => g.put(R.timingHead + 2 + i, c, `=${ref(1 + i, LATEST + j)}`))
  }

  g.put(
    R.foot,
    B,
    `="Heard back = an assessment, interview, offer or rejection; an automatic “we received it” doesn't count. Response rate counts applications 3+ weeks old. "&${m.noRole}&" applications have no role saved."`,
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
  const day = { numberFormat: { type: 'DATE', pattern: 'mmm d' } }

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
  halves(R.todoHead)
  section(R.flowHead, B, O + 1)
  merge(R.flow, R.flow + R.flowRows, B, O + 1)
  height(R.flow, R.flow + R.flowRows, SANKEY_ROWH)
  halves(R.chartsHead)
  section(R.monthsHead, B, O + 1)
  halves(R.timingHead)

  // What stands out: one sentence per line.
  for (let i = 0; i < INSIGHTS; i++) merge(R.insights + i, R.insights + i + 1, B, O + 1)
  height(R.insights, R.insights + INSIGHTS, 24)
  style([R.insights, R.insights + INSIGHTS, B, O + 1], { padding: { left: 4 }, ...text({ fontSize: 10, foregroundColor: hex(C.ink2) }) })

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
      if (i === 0 || !label || ['Role', 'Company', 'Status', 'Stage'].includes(label)) return
      style([r0 + 1, r0 + rows + 2, s[i], s[i] + 1], { horizontalAlignment: 'RIGHT' })
    })
    return s
  }
  const open = table(TABLES.open, R.todoHead, B, LIST)
  const follow = table(TABLES.follow, R.todoHead, I, LIST)
  style([R.todoHead + 2, R.todoHead + 2 + LIST, open[2], open[2] + 1], { horizontalAlignment: 'CENTER', ...text({ fontSize: 9, bold: true }) })
  style([R.todoHead + 2, R.todoHead + 2 + LIST, follow[2], follow[2] + 1], day)
  // Day counts: plain numbers (a date minus a date would show as a date).
  for (const c of [open[3], follow[3]]) style([R.todoHead + 2, R.todoHead + 2 + LIST, c, c + 1], { numberFormat: { type: 'NUMBER', pattern: '0' } })
  const months = table(TABLES.months, R.monthsHead, B, MONTHS)
  style([R.monthsHead + 2, R.monthsHead + 2 + MONTHS, months[2], months[7]], pct)
  style([R.monthsHead + 2, R.monthsHead + 2 + MONTHS, months[0], months[0] + 1], text({ bold: true }))
  const timing = table(TABLES.timing, R.timingHead, B, 4)
  style([R.timingHead + 2, R.timingHead + 6, timing[1], timing[1] + 2], { horizontalAlignment: 'RIGHT', ...text({ bold: true }) })
  const latest = table(TABLES.latest, R.timingHead, I, LIST)
  style([R.timingHead + 2, R.timingHead + 2 + LIST, latest[3], latest[3] + 1], day)
  style([R.timingHead + 2, R.timingHead + 2 + LIST, latest[2], latest[2] + 1], { horizontalAlignment: 'CENTER', ...text({ fontSize: 9, bold: true }) })

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
  for (const chips of [
    [R.todoHead + 2, R.todoHead + 2 + LIST, open[2], open[2] + 1],
    [R.timingHead + 2, R.timingHead + 2 + LIST, latest[2], latest[2] + 1],
  ] as Box[])
    for (const [s, bg, fg] of CHIPS) when(chips, { type: 'TEXT_EQ', values: [{ userEnteredValue: s }] }, { backgroundColor: hex(bg), textFormat: { foregroundColor: hex(fg) } })
  // Next steps that have sat a week: amber; two weeks: red.
  const waitedDays: Box = [R.todoHead + 2, R.todoHead + 2 + LIST, open[3], open[3] + 1]
  when(waitedDays, { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '14' }] }, { textFormat: { foregroundColor: hex(C.critical), bold: true } })
  when(waitedDays, { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '7' }] }, { textFormat: { foregroundColor: hex(C.late), bold: true } })
  rules.forEach((rule, index) => out.push({ addConditionalFormatRule: { index, rule } }))

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
            domains: [{ domain: src(0, 6, AGE) }],
            series: [{ series: src(0, 6, AGE + 1), targetAxis: 'BOTTOM_AXIS', colorStyle: { rgbColor: hex(C.blue) } }],
          },
        },
        position: place(I),
      },
    },
  })
  return out
}
