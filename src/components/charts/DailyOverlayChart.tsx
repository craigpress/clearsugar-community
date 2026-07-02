"use client";

import { useMemo } from "react";
import { LinePath } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { curveMonotoneX } from "@visx/curve";
import { ParentSize } from "@visx/responsive";
import type { DailyProfile } from "@/lib/trends";
import { GLUCOSE_RANGES } from "@/lib/types";

interface DailyOverlayChartProps {
  profiles: DailyProfile[];
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

// Colors by day of week — consistent regardless of date
const DOW_COLORS: Record<string, string> = {
  Sun: "#ef5350",
  Mon: "#42a5f5",
  Tue: "#66bb6a",
  Wed: "#ffa726",
  Thu: "#ab47bc",
  Fri: "#26c6da",
  Sat: "#ec407a",
};

const DOW_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Chart({
  profiles,
  width,
  height,
}: {
  profiles: DailyProfile[];
  width: number;
  height: number;
}) {
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const xScale = useMemo(
    () => scaleLinear({ domain: [0, 1440], range: [0, innerWidth] }),
    [innerWidth]
  );
  const yScale = useMemo(
    () =>
      scaleLinear({ domain: [Y_MIN, Y_MAX], range: [innerHeight, 0], nice: true }),
    [innerHeight]
  );

  // For many days, reduce opacity so the overlay doesn't become opaque
  const lineOpacity = profiles.length > 14 ? 0.3 : profiles.length > 7 ? 0.45 : 0.6;

  return (
    <svg width={width} height={height}>
      <Group left={margin.left} top={margin.top}>
        {/* Target range */}
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

        {/* Each day as a separate line — colored by day of week */}
        {profiles.map((profile) => {
          const sorted = [...profile.readings].sort(
            (a, b) => a.minuteOfDay - b.minuteOfDay
          );
          const color = DOW_COLORS[profile.dayOfWeek] || "#888";
          return (
            <LinePath
              key={profile.date}
              data={sorted}
              x={(d) => xScale(d.minuteOfDay)}
              y={(d) =>
                yScale(Math.min(Math.max(d.sgv, Y_MIN), Y_MAX))
              }
              stroke={color}
              strokeWidth={1.5}
              curve={curveMonotoneX}
              opacity={lineOpacity}
              strokeLinecap="round"
            />
          );
        })}

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
      </Group>

      {/* Legend — by day of week with count */}
      <Group left={width - margin.right - 100} top={margin.top + 4}>
        {DOW_ORDER.map((dow, i) => {
          const count = profiles.filter((p) => p.dayOfWeek === dow).length;
          if (count === 0) return null;
          return (
            <g key={dow} transform={`translate(0, ${i * 16})`}>
              <line
                x1={0}
                x2={14}
                y1={6}
                y2={6}
                stroke={DOW_COLORS[dow]}
                strokeWidth={2.5}
                opacity={0.8}
              />
              <text
                x={18}
                y={9}
                fill="var(--text-secondary)"
                fontSize={11}
                fontFamily="var(--font-geist-mono)"
              >
                {dow} ({count})
              </text>
            </g>
          );
        })}
      </Group>
    </svg>
  );
}

export function DailyOverlayChart({
  profiles,
  height = 300,
}: DailyOverlayChartProps) {
  return (
    <ParentSize>
      {({ width }) =>
        width > 0 ? (
          <Chart profiles={profiles} width={width} height={height} />
        ) : null
      }
    </ParentSize>
  );
}
