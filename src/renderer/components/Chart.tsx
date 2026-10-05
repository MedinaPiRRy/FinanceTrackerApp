import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { useTheme } from '../theme'

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

export interface ChartColors { s1: string; s2: string; s3: string; text: string; text2: string; muted: string; grid: string; surface: string }

function readColors(): ChartColors {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  return { s1: v('--series-1'), s2: v('--series-2'), s3: v('--series-3'), text: v('--text'), text2: v('--text-2'), muted: v('--text-3'), grid: v('--grid'), surface: v('--surface') }
}

interface Props {
  build: (c: ChartColors) => EChartsCoreOption
  height?: number
  label: string
  onClick?: (name: string) => void
}

/** ECharts wrapper. Rebuilt when the theme changes so colours always come from the active tokens. */
export function Chart({ build, height = 280, label, onClick }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const { resolved } = useTheme()

  useEffect(() => {
    if (!el.current) return
    const chart = echarts.init(el.current, undefined, { renderer: 'canvas' })
    chart.setOption(build(readColors()))
    if (onClick) chart.on('click', (p) => onClick(String(p.name)))
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
      chart.dispose()
    }
  }, [build, resolved, onClick])

  return <div ref={el} className="chart" style={{ height }} role="img" aria-label={label} />
}
