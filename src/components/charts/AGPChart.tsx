"use client";

import { useMemo } from "react";
import { AreaClosed, LinePath } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { curveMonotoneX } from "@visx/curve";
import { ParentSize } from "@visx/responsive";
import type { AGPSlot } from "@/lib/trends";
import { GLUCOSE_RANGES } from "@/lib/types";

interface AGPChartProps {
  slots: AGPSlot[];
  height?: number;
}

const margin = { top: 16, right: 16, bottom: 40, left: 44 };
const Y_MIN = 40;
const Y_MAX = 350;

const TIME_LABELS = [
  { min: 0, label: "12a" },
  { min: 180, label: "3a" },
  { min: 360, label: "6a" },
  { min: 540, label: "9a" },
  { min: 720, label: "12p" },
  { min: 900, label: "3p" },
  { min: 1080, label: "6p" },
  { min: 1260, label: "9p" },
  { min: 1440, label: "" },
];

function Chart({
  slots,
  width,
  height,
}: {
  slots: AGPSlot[];
  width: number;
  height: number;
}) {
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const validSlots = useMemo(
    () => slots.filter((s) => s.count > 0),
    [slots]
  );

  const xScale = useMemo(
    () => scaleLinear({ domain: [0, 1440], range: [0, innerWidth] }),
    [innerWidth]
  );

  const yScale = useMemo(
    () => scaleLinear({ domain: [Y_MIN, Y_MAX], range: [innerHeight, 0], nice: true }),
    [innerHeight]
  );

  if (validSlots.length < 4) {
    return (
      <div
        className="flex items-center justify-center text-[var(--text-secondary)]"
        style={{ height }}
      >
        Not enough data for AGP profile (need at least 7 days)
      </div>
    );
  }

  return (
    <svg width={width} height={height}>
      <Group left={margin.left} top={margin.top}>
        {/* Target range band */}
        <rect
          x={0}
          y={yScale(GLUCOSE_RANGES.TARGET_HIGH)}
          width={innerWidth}
          height={
            yScale(GLUCOSE_RANGES.TARGET_LOW) -
            yScale(GLUCOSE_RANGES.TARGET_HIGH)
          }
          fill="var(--range-band)"
        />

        <GridRows
          scale={yScale}
          width={innerWidth}
          stroke="var(--grid-line)"
          numTicks={6}
        />

        {/* P10-P90 band (lightest) */}
        <AreaClosed
          data={validSlots}
          x={(d) => xScale(d.minuteOfDay)}
          y0={(d) => yScale(Math.min(d.p10, Y_MAX))}
          y1={(d) => yScale(Math.min(d.p90, Y_MAX))}
          yScale={yScale}
          curve={curveMonotoneX}
          fill="var(--accent)"
          opacity={0.08}
        />

        {/* P25-P75 band (medium) */}
        <AreaClosed
          data={validSlots}
          x={(d) => xScale(d.minuteOfDay)}
          y0={(d) => yScale(Math.min(d.p25, Y_MAX))}
          y1={(d) => yScale(Math.min(d.p75, Y_MAX))}
          yScale={yScale}
          curve={curveMonotoneX}
          fill="var(--accent)"
          opacity={0.15}
        />

        {/* P50 median line */}
        <LinePath
          data={validSlots}
          x={(d) => xScale(d.minuteOfDay)}
          y={(d) => yScale(Math.min(Math.max(d.p50, Y_MIN), Y_MAX))}
          stroke="var(--accent)"
          strokeWidth={2.5}
          curve={curveMonotoneX}
          strokeLinecap="round"
        />

        {/* P10 and P90 dashed lines */}
        <LinePath
          data={validSlots}
          x={(d) => xScale(d.minuteOfDay)}
          y={(d) => yScale(Math.min(Math.max(d.p10, Y_MIN), Y_MAX))}
          stroke="var(--accent)"
          strokeWidth={1}
          strokeDasharray="3,3"
          curve={curveMonotoneX}
          opacity={0.4}
        />
        <LinePath
          data={validSlots}
          x={(d) => xScale(d.minuteOfDay)}
          y={(d) => yScale(Math.min(Math.max(d.p90, Y_MIN), Y_MAX))}
          stroke="var(--accent)"
          strokeWidth={1}
          strokeDasharray="3,3"
          curve={curveMonotoneX}
          opacity={0.4}
        />

        {/* Threshold lines */}
        <line
          x1={0} x2={innerWidth}
          y1={yScale(GLUCOSE_RANGES.URGENT_LOW)}
          y2={yScale(GLUCOSE_RANGES.URGENT_LOW)}
          stroke="var(--glucose-urgent-low)"
          strokeWidth={1}
          strokeDasharray="4,4"
          opacity={0.3}
        />
        <line
          x1={0} x2={innerWidth}
          y1={yScale(GLUCOSE_RANGES.HIGH)}
          y2={yScale(GLUCOSE_RANGES.HIGH)}
          stroke="var(--glucose-high)"
          strokeWidth={1}
          strokeDasharray="4,4"
          opacity={0.2}
        />

        {/* Y axis */}
        <AxisLeft
          scale={yScale}
          numTicks={6}
          stroke="var(--border)"
          tickStroke="var(--border)"
          tickLabelProps={() => ({
            fill: "var(--text-secondary)",
            fontSize: 11,
            fontFamily: "var(--font-geist-mono)",
            textAnchor: "end" as const,
            dx: -4,
            dy: 3,
          })}
        />

        {/* X axis — time of day */}
        <AxisBottom
          scale={xScale}
          top={innerHeight}
          stroke="var(--border)"
          tickStroke="var(--border)"
          tickValues={TIME_LABELS.map((t) => t.min)}
          tickFormat={(v) =>
            TIME_LABELS.find((t) => t.min === v)?.label || ""
          }
          tickLabelProps={() => ({
            fill: "var(--text-secondary)",
            fontSize: 11,
            fontFamily: "var(--font-geist-mono)",
            textAnchor: "middle" as const,
            dy: 4,
          })}
        />

        {/* Legend */}
        <g transform={`translate(${innerWidth - 120}, 8)`}>
          <rect width={115} height={52} rx={6} fill="var(--bg-elevated)" opacity={0.9} />
          <line x1={8} x2={28} y1={14} stroke="var(--accent)" strokeWidth={2.5} />
          <text x={32} y={17} fill="var(--text-secondary)" fontSize={10}>Median (p50)</text>
          <rect x={8} y={24} width={20} height={8} fill="var(--accent)" opacity={0.15} rx={2} />
          <text x={32} y={31} fill="var(--text-secondary)" fontSize={10}>p25–p75</text>
          <rect x={8} y={38} width={20} height={8} fill="var(--accent)" opacity={0.08} rx={2} />
          <text x={32} y={45} fill="var(--text-secondary)" fontSize={10}>p10–p90</text>
        </g>
      </Group>
    </svg>
  );
}

export function AGPChart({ slots, height = 300 }: AGPChartProps) {
  return (
    <ParentSize>
      {({ width }) =>
        width > 0 ? (
          <Chart slots={slots} width={width} height={height} />
        ) : null
      }
    </ParentSize>
  );
}
