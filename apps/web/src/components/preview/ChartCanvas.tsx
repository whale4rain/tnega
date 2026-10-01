import type { ChartConfiguration } from 'chart.js'
import { useEffect, useRef } from 'react'
import type { ChartView } from '../../lib/ooxml-chart'

const PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#264478', '#9E480E']

export function chartConfig(chart: ChartView): ChartConfiguration {
  const round = chart.kind === 'pie' || chart.kind === 'doughnut'
  const datasets = chart.series.map((series, index) => {
    const color = series.color ?? PALETTE[index % PALETTE.length] ?? '#4472C4'
    return {
      label: series.name,
      data: series.values,
      backgroundColor: round ? chart.categories.map((_, point) => PALETTE[point % PALETTE.length] ?? '#4472C4') : color,
      borderColor: round ? '#ffffff' : color,
      ...(chart.kind === 'area' ? { fill: true, backgroundColor: `${color}66` } : {}),
    }
  })
  const type: 'bar' | 'line' | 'pie' | 'doughnut' = chart.kind === 'column' || chart.kind === 'bar'
    ? 'bar'
    : chart.kind === 'pie' || chart.kind === 'doughnut' ? chart.kind : 'line'
  return {
    type,
    data: { labels: chart.categories, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      ...(chart.kind === 'bar' ? { indexAxis: 'y' as const } : {}),
      plugins: {
        legend: { position: 'bottom' as const },
        ...(chart.title ? { title: { display: true, text: chart.title } } : {}),
      },
      ...(!round ? { scales: { x: { stacked: chart.stacked }, y: { stacked: chart.stacked, beginAtZero: true } } } : {}),
    },
  }
}

/** Draws a chart read out of an Office file; chart.js loads only when the first chart is shown. */
export function ChartCanvas({ chart, fill = false }: { chart: ChartView; fill?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    let instance: { destroy(): void } | undefined
    void import('chart.js/auto').then(({ default: Chart }) => {
      if (cancelled || !canvas.current) return
      instance = new Chart(canvas.current, chartConfig(chart))
    })
    return () => {
      cancelled = true
      instance?.destroy()
    }
  }, [chart])
  if (fill) {
    // Fills a box the document already sized for the chart.
    return <div className="chart-fill"><canvas ref={canvas} role="img" aria-label={chart.title ?? 'Chart'} /></div>
  }
  return (
    <figure className="chart-figure">
      {chart.kind === 'other'
        ? <div className="file-preview-status">This chart type can't be previewed. Download the file to see it.</div>
        : <div className="chart-canvas"><canvas ref={canvas} role="img" aria-label={chart.title ?? 'Chart'} /></div>}
      {chart.anchor && <figcaption className="muted small">Placed at {chart.anchor}</figcaption>}
    </figure>
  )
}
