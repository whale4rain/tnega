import { useEffect, useState } from 'react'
import { errorText } from '../../lib/hooks'
import { sheetView, type SheetView, MAX_PREVIEW_COLUMNS, MAX_PREVIEW_ROWS } from '../../lib/xlsx-view'
import type { ChartView } from '../../lib/ooxml-chart'
import { ChartCanvas } from './ChartCanvas'
import type { PreviewProps } from './FilePreview'

function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

export default function XlsxPreview({ blob }: PreviewProps) {
  const [sheets, setSheets] = useState<SheetView[] | undefined>()
  const [charts, setCharts] = useState<Map<string, ChartView[]>>(new Map())
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [{ Workbook }, { default: JSZip }, { workbookCharts }] = await Promise.all([
          import('exceljs'), import('jszip'), import('../../lib/ooxml-chart'),
        ])
        const buffer = await blob.arrayBuffer()
        const workbook = new Workbook()
        await workbook.xlsx.load(buffer)
        // exceljs ignores charts; read them straight from the package.
        const found = await workbookCharts(await JSZip.loadAsync(buffer))
        if (cancelled) return
        setSheets(workbook.worksheets.map(sheetView))
        setCharts(found)
      } catch (reason) {
        if (!cancelled) setError(errorText(reason))
      }
    })()
    return () => { cancelled = true }
  }, [blob])

  if (error) return <div className="notice notice-error"><span>Could not read this workbook: {error}</span></div>
  if (!sheets) return <div className="file-preview-status"><span className="spinner" /> Reading workbook…</div>
  const sheet = sheets[active]
  return (
    <div className="xlsx-preview">
      <div className="xlsx-grid-wrap">
        {sheet && sheet.rows.length > 0 ? (
          <table className="xlsx-grid">
            <colgroup>
              <col style={{ width: 44 }} />
              {sheet.widths.map((width, index) => <col key={index} style={{ width }} />)}
            </colgroup>
            <thead>
              <tr>
                <th />
                {sheet.widths.map((_, index) => <th key={index}>{columnName(index)}</th>)}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  <th>{r + 1}</th>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className={cell.numeric ? 'numeric' : undefined}
                      style={{
                        ...(cell.bold ? { fontWeight: 600 } : {}),
                        ...(cell.italic ? { fontStyle: 'italic' } : {}),
                        ...(cell.fill ? { background: cell.fill, color: '#1f1f1f' } : {}),
                        ...(cell.align ? { textAlign: cell.align } : {}),
                      }}
                    >
                      {cell.text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="file-preview-status">This sheet is empty.</div>}
      </div>
      {sheet && (charts.get(sheet.name) ?? []).length > 0 && (
        <div className="chart-list">
          {(charts.get(sheet.name) ?? []).map((chart, index) => <ChartCanvas key={`${sheet.name}:${index}`} chart={chart} />)}
        </div>
      )}
      {sheet?.truncated && (
        <p className="muted small">Showing the first {MAX_PREVIEW_ROWS} rows and {MAX_PREVIEW_COLUMNS} columns. Download the file to see everything.</p>
      )}
      {sheets.length > 1 && (
        <div className="xlsx-tabs" role="tablist">
          {sheets.map((each, index) => (
            <button key={each.name} type="button" role="tab" aria-selected={index === active} className={index === active ? 'active' : undefined} onClick={() => setActive(index)}>
              {each.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
