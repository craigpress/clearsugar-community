"use client";

import { useMemo, useRef, useEffect, useLayoutEffect, useState } from "react";
import { LinePath, Bar } from "@visx/shape";
import { scaleTime, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { curveMonotoneX } from "@visx/curve";
import { ParentSize } from "@visx/responsive";
import { useTooltip } from "@visx/tooltip";
import { localPoint } from "@visx/event";
import { createPortal } from "react-dom";
import { bisector } from "d3-array";
import type { GlucoseReading, Treatment } from "@/lib/types";
import { GLUCOSE_RANGES, TREND_ARROWS } from "@/lib/types";
import { glucoseColorClass } from "@/lib/statistics";
import type { PredictionPoint } from "@/lib/prediction/types";

interface GlucoseChartProps {
  readings: GlucoseReading[];
  boluses?: Treatment[];
  carbs?: Treatment[];
  basals?: Treatment[];
  predictions?: PredictionPoint[];
  height?: number;
}

const margin = { top: 20, right: 16, bottom: 8, left: 44 };
const TREATMENT_LANE_HEIGHT = 32;
const BASAL_CHART_HEIGHT = 60;
const BASAL_GAP = 4;
const BASAL_MARGIN_BOTTOM = 32; // space for x-axis labels
const Y_MIN = 40;
const Y_MAX = 350;

type TooltipPayload =
  | { kind: "glucose"; data: GlucoseReading }
  | { kind: "bolus"; data: Treatment }
  | { kind: "carb"; data: Treatment };

const bisectDate = bisector<GlucoseReading, number>((d) => d.date).left;

function getStrokeColor(sgv: number) {
  if (sgv < GLUCOSE_RANGES.URGENT_LOW) return "var(--glucose-urgent-low)";
  if (sgv < GLUCOSE_RANGES.LOW) return "var(--glucose-low)";
  if (sgv <= GLUCOSE_RANGES.TARGET_HIGH) return "var(--glucose-in-range)";
  if (sgv <= GLUCOSE_RANGES.HIGH) return "var(--glucose-high)";
  return "var(--glucose-urgent-high)";
}

function treatmentTime(t: Treatment): number {
  return t.mills || new Date(t.created_at).getTime();
}

function Chart({
  readings,
  boluses = [],
  carbs = [],
  basals = [],
  predictions = [],
  width,
  height,
}: {
  readings: GlucoseReading[];
  boluses: Treatment[];
  carbs: Treatment[];
  basals: Treatment[];
  predictions: PredictionPoint[];
  width: number;
  height: number;
}) {
  const {
    showTooltip,
    hideTooltip,
    tooltipData,
    tooltipOpen,
  } = useTooltip<TooltipPayload>();

  // Track mouse screen position for fixed-position tooltip
  const mousePos = useRef({ x: 0, y: 0 });
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const innerWidth = width - margin.left - margin.right;
  const totalHeight = height;
  // Layout: margin.top → treatment lane → glucose chart → gap → basal chart → x-axis → margin.bottom
  const glucoseHeight =
    totalHeight -
    margin.top -
    TREATMENT_LANE_HEIGHT -
    BASAL_GAP -
    BASAL_CHART_HEIGHT -
    BASAL_MARGIN_BOTTOM -
    margin.bottom;

  const sorted = useMemo(
    () => [...readings].sort((a, b) => a.date - b.date),
    [readings]
  );

  const xScale = useMemo(() => {
    if (sorted.length === 0)
      return scaleTime({
        domain: [new Date(), new Date()],
        range: [0, innerWidth],
      });
    const dataEnd = sorted[sorted.length - 1].date;
    // Extend domain to include prediction horizon if present
    const domainEnd =
      predictions.length > 0
        ? Math.max(dataEnd, predictions[predictions.length - 1].timestamp)
        : dataEnd;
    return scaleTime({
      domain: [new Date(sorted[0].date), new Date(domainEnd)],
      range: [0, innerWidth],
    });
  }, [sorted, predictions, innerWidth]);

  const yScale = useMemo(
    () =>
      scaleLinear({
        domain: [Y_MIN, Y_MAX],
        range: [glucoseHeight, 0],
        nice: true,
      }),
    [glucoseHeight]
  );

  // Scale for bolus marker size (insulin units → pixel height)
  const maxBolus = useMemo(
    () => Math.max(...boluses.map((b) => b.insulin || 0), 1),
    [boluses]
  );

  const handleMouseMove = (event: React.MouseEvent<SVGRectElement>) => {
    const point = localPoint(event);
    if (!point) return;
    const x0 = xScale.invert(point.x - margin.left).getTime();
    const idx = bisectDate(sorted, x0, 1);
    const d0 = sorted[idx - 1];
    const d1 = sorted[idx];
    if (!d0) return;
    const d = d1 && x0 - d0.date > d1.date - x0 ? d1 : d0;
    mousePos.current = { x: event.clientX, y: event.clientY };
    setTooltipPos({ x: event.clientX, y: event.clientY });
    showTooltip({
      tooltipData: { kind: "glucose", data: d },
      tooltipLeft: xScale(new Date(d.date)),
      tooltipTop: yScale(d.sgv),
    });
  };

  if (sorted.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[var(--text-secondary)]"
        style={{ height }}
      >
        No glucose data for this period
      </div>
    );
  }

  return (
    <div className="relative">
      <svg width={width} height={height}>
        {/* Treatment lane (top area for bolus/carb markers) */}
        <Group left={margin.left} top={margin.top}>
          {/* Bolus markers — blue bars dropping down from top */}
          {boluses.map((b, i) => {
            const x = xScale(new Date(treatmentTime(b)));
            const units = b.insulin || 0;
            const barH = Math.max(
              4,
              (units / maxBolus) * (TREATMENT_LANE_HEIGHT - 4)
            );
            return (
              <g
                key={`bolus-${i}`}
                onMouseEnter={(e) => {
                  setTooltipPos({ x: e.clientX, y: e.clientY });
                  showTooltip({
                    tooltipData: { kind: "bolus", data: b },
                    tooltipLeft: x,
                    tooltipTop: 0,
                  });
                }}
                onMouseLeave={hideTooltip}
                onClick={(e) => {
                  e.stopPropagation();
                  setTooltipPos({ x: e.clientX, y: e.clientY });
                  showTooltip({
                    tooltipData: { kind: "bolus", data: b },
                    tooltipLeft: x,
                    tooltipTop: 0,
                  });
                }}
                style={{ cursor: "pointer" }}
              >
                {/* Invisible hit area for easier tap/click */}
                <rect
                  x={x - 12}
                  y={0}
                  width={24}
                  height={TREATMENT_LANE_HEIGHT}
                  fill="transparent"
                />
                <Bar
                  x={x - 3}
                  y={TREATMENT_LANE_HEIGHT - barH}
                  width={6}
                  height={barH}
                  fill="var(--insulin-blue)"
                  rx={2}
                  opacity={0.85}
                />
                {/* Label below the bar */}
                {units >= 0.5 && (
                  <text
                    x={x}
                    y={TREATMENT_LANE_HEIGHT + 10}
                    textAnchor="middle"
                    fill="var(--insulin-blue)"
                    fontSize={9}
                    fontFamily="var(--font-geist-mono)"
                    opacity={0.9}
                  >
                    {units.toFixed(1)}u
                  </text>
                )}
              </g>
            );
          })}

          {/* Carb markers — amber circles */}
          {carbs.map((c, i) => {
            const x = xScale(new Date(treatmentTime(c)));
            const grams = c.carbs || 0;
            const r = Math.max(4, Math.min(12, Math.sqrt(grams) * 1.8));
            return (
              <g
                key={`carb-${i}`}
                onMouseEnter={(e) => {
                  setTooltipPos({ x: e.clientX, y: e.clientY });
                  showTooltip({
                    tooltipData: { kind: "carb", data: c },
                    tooltipLeft: x,
                    tooltipTop: 0,
                  });
                }}
                onMouseLeave={hideTooltip}
                onClick={(e) => {
                  e.stopPropagation();
                  setTooltipPos({ x: e.clientX, y: e.clientY });
                  showTooltip({
                    tooltipData: { kind: "carb", data: c },
                    tooltipLeft: x,
                    tooltipTop: 0,
                  });
                }}
                style={{ cursor: "pointer" }}
              >
                {/* Invisible hit area for easier tap/click */}
                <circle
                  cx={x}
                  cy={TREATMENT_LANE_HEIGHT - 8}
                  r={Math.max(r + 8, 16)}
                  fill="transparent"
                />
                <circle
                  cx={x}
                  cy={TREATMENT_LANE_HEIGHT - 8}
                  r={r}
                  fill="var(--carb-amber)"
                  opacity={0.7}
                  stroke="var(--carb-amber)"
                  strokeWidth={1}
                  strokeOpacity={0.3}
                />
                {/* Always show carb grams inside the circle */}
                <text
                  x={x}
                  y={TREATMENT_LANE_HEIGHT - 8}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="var(--background)"
                  fontSize={r > 6 ? 8 : 7}
                  fontWeight={600}
                  fontFamily="var(--font-geist-mono)"
                >
                  {grams}
                </text>
              </g>
            );
          })}

          {/* Divider line between treatment lane and glucose chart */}
          <line
            x1={0}
            x2={innerWidth}
            y1={TREATMENT_LANE_HEIGHT}
            y2={TREATMENT_LANE_HEIGHT}
            stroke="var(--border)"
            strokeWidth={0.5}
          />
        </Group>

        {/* Glucose chart area */}
        <Group
          left={margin.left}
          top={margin.top + TREATMENT_LANE_HEIGHT}
        >
          {/* Target range band (70-180) */}
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

          {/* Threshold lines */}
          <line
            x1={0}
            x2={innerWidth}
            y1={yScale(GLUCOSE_RANGES.URGENT_LOW)}
            y2={yScale(GLUCOSE_RANGES.URGENT_LOW)}
            stroke="var(--glucose-urgent-low)"
            strokeWidth={1}
            strokeDasharray="4,4"
            opacity={0.4}
          />
          <line
            x1={0}
            x2={innerWidth}
            y1={yScale(GLUCOSE_RANGES.HIGH)}
            y2={yScale(GLUCOSE_RANGES.HIGH)}
            stroke="var(--glucose-high)"
            strokeWidth={1}
            strokeDasharray="4,4"
            opacity={0.3}
          />

          {/* Grid */}
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke="var(--grid-line)"
            numTicks={6}
          />

          {/* Glucose line — color-coded by range */}
          {(() => {
            // Split readings into segments by glucose range for colored line
            const segments: { data: typeof sorted; color: string }[] = [];
            let currentColor = "";
            let currentSegment: typeof sorted = [];

            for (const d of sorted) {
              const color = getStrokeColor(d.sgv);
              if (color !== currentColor && currentSegment.length > 0) {
                segments.push({ data: [...currentSegment], color: currentColor });
                // Overlap: include last point of previous segment as first of next
                currentSegment = [currentSegment[currentSegment.length - 1]];
              }
              currentSegment.push(d);
              currentColor = color;
            }
            if (currentSegment.length > 0) {
              segments.push({ data: currentSegment, color: currentColor });
            }

            return segments.map((seg, i) => (
              <LinePath
                key={`seg-${i}`}
                data={seg.data}
                x={(d) => xScale(new Date(d.date))}
                y={(d) => yScale(Math.min(Math.max(d.sgv, Y_MIN), Y_MAX))}
                stroke={seg.color}
                strokeWidth={2.5}
                curve={curveMonotoneX}
                strokeLinecap="round"
              />
            ));
          })()}

          {/* Color dots at each reading */}
          {sorted.map((d) => (
            <circle
              key={d._id}
              cx={xScale(new Date(d.date))}
              cy={yScale(Math.min(Math.max(d.sgv, Y_MIN), Y_MAX))}
              r={2.5}
              fill={getStrokeColor(d.sgv)}
              opacity={0.9}
            />
          ))}

          {/* Prediction confidence band + dashed line */}
          {predictions.length > 0 && (() => {
            const lastReading = sorted[sorted.length - 1];
            const anchor = { timestamp: lastReading.date, sgv: lastReading.sgv, confidence: { low: lastReading.sgv, high: lastReading.sgv } };
            // Build prediction data starting from last real reading
            const predData = [anchor, ...predictions];

            // Future zone background tint
            const futureX = xScale(new Date(lastReading.date));

            // De-emphasize long-horizon predictions (>= 120 min from now): these
            // carry high uncertainty (RMSE ~45+). Split the trajectory into a
            // "near" (<120 min) segment shown normally and a faded/dashed "far"
            // (>= 120 min) tail. Offset is minutes from the last real reading.
            const LOW_CONF_MIN = 120;
            const offsetMin = (ts: number) => (ts - lastReading.date) / 60_000;
            // Index of the first far point within predData (>= LOW_CONF_MIN).
            let splitIdx = predData.length;
            for (let i = 0; i < predData.length; i++) {
              if (offsetMin(predData[i].timestamp) >= LOW_CONF_MIN) {
                splitIdx = i;
                break;
              }
            }
            const hasFar = splitIdx < predData.length;
            const nearData = predData.slice(0, hasFar ? splitIdx + 1 : predData.length);
            // Overlap one point so near and far segments visually connect.
            const farData = hasFar ? predData.slice(splitIdx - 1) : [];

            const bandPath = (pts: typeof predData) =>
              [
                ...pts.map((p, i) =>
                  `${i === 0 ? "M" : "L"} ${xScale(new Date(p.timestamp))} ${yScale(Math.min(Math.max(p.confidence.high, Y_MIN), Y_MAX))}`
                ),
                ...pts.slice().reverse().map((p) =>
                  `L ${xScale(new Date(p.timestamp))} ${yScale(Math.min(Math.max(p.confidence.low, Y_MIN), Y_MAX))}`
                ),
                "Z",
              ].join(" ");

            // Caption anchored at the start of the low-confidence segment.
            const farStartX = hasFar ? xScale(new Date(predData[splitIdx].timestamp)) : 0;

            return (
              <>
                {/* Subtle future zone overlay */}
                <rect
                  x={futureX}
                  y={0}
                  width={Math.max(0, innerWidth - futureX)}
                  height={glucoseHeight}
                  fill="var(--text-secondary)"
                  opacity={0.03}
                />

                {/* Confidence band — near (full opacity) */}
                <path
                  d={bandPath(nearData)}
                  fill="var(--prediction-band, oklch(0.7 0.15 250))"
                  opacity={0.12}
                />

                {/* Confidence band — far/low-confidence (more faded) */}
                {hasFar && (
                  <path
                    d={bandPath(farData)}
                    fill="var(--prediction-band, oklch(0.7 0.15 250))"
                    opacity={0.05}
                  />
                )}

                {/* Prediction line — near (dashed, normal emphasis) */}
                <LinePath
                  data={nearData}
                  x={(d) => xScale(new Date(d.timestamp))}
                  y={(d) => yScale(Math.min(Math.max(d.sgv, Y_MIN), Y_MAX))}
                  stroke="var(--prediction-line, oklch(0.7 0.15 250))"
                  strokeWidth={2}
                  strokeDasharray="6,4"
                  curve={curveMonotoneX}
                  strokeLinecap="round"
                  opacity={0.8}
                />

                {/* Prediction line — far/low-confidence (faded, finer dashes) */}
                {hasFar && (
                  <LinePath
                    data={farData}
                    x={(d) => xScale(new Date(d.timestamp))}
                    y={(d) => yScale(Math.min(Math.max(d.sgv, Y_MIN), Y_MAX))}
                    stroke="var(--prediction-line, oklch(0.7 0.15 250))"
                    strokeWidth={1.5}
                    strokeDasharray="2,4"
                    curve={curveMonotoneX}
                    strokeLinecap="round"
                    opacity={0.35}
                  />
                )}

                {/* Low-confidence caption at the >=2h boundary */}
                {hasFar && (
                  <text
                    x={farStartX + 4}
                    y={10}
                    fill="var(--text-secondary)"
                    fontSize={9}
                    fontFamily="var(--font-geist-mono)"
                    opacity={0.6}
                  >
                    ≥2 h: low confidence
                  </text>
                )}

                {/* Endpoint dot — faded when it lands in the low-confidence tail */}
                {predictions.length > 0 && (() => {
                  const last = predictions[predictions.length - 1];
                  const faded = offsetMin(last.timestamp) >= LOW_CONF_MIN;
                  return (
                    <circle
                      cx={xScale(new Date(last.timestamp))}
                      cy={yScale(Math.min(Math.max(last.sgv, Y_MIN), Y_MAX))}
                      r={4}
                      fill="var(--prediction-line, oklch(0.7 0.15 250))"
                      stroke="var(--background)"
                      strokeWidth={1.5}
                      opacity={faded ? 0.4 : 0.9}
                    />
                  );
                })()}
              </>
            );
          })()}

          {/* Axes */}
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
          {/* Tooltip hover zone */}
          <rect
            width={innerWidth}
            height={glucoseHeight}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onMouseLeave={hideTooltip}
          />

          {/* Tooltip crosshair */}
          {tooltipOpen &&
            tooltipData?.kind === "glucose" && (
              <>
                <line
                  x1={xScale(new Date(tooltipData.data.date))}
                  x2={xScale(new Date(tooltipData.data.date))}
                  y1={0}
                  y2={glucoseHeight}
                  stroke="var(--text-secondary)"
                  strokeWidth={1}
                  strokeDasharray="2,2"
                  opacity={0.5}
                />
                <circle
                  cx={xScale(new Date(tooltipData.data.date))}
                  cy={yScale(
                    Math.min(
                      Math.max(tooltipData.data.sgv, Y_MIN),
                      Y_MAX
                    )
                  )}
                  r={5}
                  fill={getStrokeColor(tooltipData.data.sgv)}
                  stroke="var(--background)"
                  strokeWidth={2}
                />
              </>
            )}
        </Group>

        {/* ── Basal Rate Panel (separate Y-axis: U/hr) ── */}
        <Group
          left={margin.left}
          top={margin.top + TREATMENT_LANE_HEIGHT + glucoseHeight + BASAL_GAP}
        >
          {/* Basal panel background */}
          <rect
            x={0}
            y={0}
            width={innerWidth}
            height={BASAL_CHART_HEIGHT}
            fill="var(--bg-surface)"
            opacity={0.5}
          />

          {/* Basal rate stepped area + step line */}
          {basals.length > 0 && (() => {
            // Sort by time and deduplicate — Control-IQ issues overlapping temp basals
            const sortedBasals = [...basals]
              .sort((a, b) => treatmentTime(a) - treatmentTime(b));

            // Build clean step data: each entry defines rate from its start
            // until the next entry starts
            const steps: { x: number; rate: number }[] = [];
            for (let i = 0; i < sortedBasals.length; i++) {
              const b = sortedBasals[i];
              const x = xScale(new Date(treatmentTime(b)));
              const rate = b.rate || b.absolute || 0;

              // Skip if same x position as previous (duplicate timestamp)
              if (steps.length > 0 && Math.abs(x - steps[steps.length - 1].x) < 1) {
                steps[steps.length - 1].rate = rate; // update rate
                continue;
              }
              steps.push({ x, rate });
            }

            const maxRate = 3;

            // Build area path (filled) and step line path
            const areaPoints: string[] = [];
            const linePoints: string[] = [];

            for (let i = 0; i < steps.length; i++) {
              const { x, rate } = steps[i];
              const nextX = i < steps.length - 1 ? steps[i + 1].x : x + 20; // extend last step
              const y = BASAL_CHART_HEIGHT - Math.min(1, rate / maxRate) * BASAL_CHART_HEIGHT;

              // Step line: horizontal at this rate, then vertical to next rate
              linePoints.push(`${x},${y}`);
              linePoints.push(`${nextX},${y}`);

              // Area: rectangles from bottom to rate
              const barH = Math.min(BASAL_CHART_HEIGHT, (rate / maxRate) * BASAL_CHART_HEIGHT);
              areaPoints.push(
                `<rect x="${x}" y="${BASAL_CHART_HEIGHT - barH}" width="${Math.max(1, nextX - x)}" height="${barH}" />`
              );
            }

            return (
              <>
                {/* Filled area */}
                {steps.map((step, i) => {
                  const nextX = i < steps.length - 1 ? steps[i + 1].x : step.x + 20;
                  const barH = Math.min(BASAL_CHART_HEIGHT, (step.rate / maxRate) * BASAL_CHART_HEIGHT);
                  return (
                    <rect
                      key={`basal-area-${i}`}
                      x={step.x}
                      y={BASAL_CHART_HEIGHT - barH}
                      width={Math.max(1, nextX - step.x)}
                      height={barH}
                      fill="var(--insulin-blue)"
                      opacity={0.35}
                    />
                  );
                })}
                {/* Step line */}
                <polyline
                  points={linePoints.join(" ")}
                  fill="none"
                  stroke="var(--insulin-blue)"
                  strokeWidth={1.5}
                  opacity={0.8}
                />
              </>
            );
          })()}

          {/* Basal Y-axis label */}
          <text
            x={-8}
            y={BASAL_CHART_HEIGHT / 2}
            textAnchor="end"
            dominantBaseline="central"
            fill="var(--text-secondary)"
            fontSize={10}
            fontFamily="var(--font-geist-mono)"
          >
            U/hr
          </text>

          {/* Basal Y-axis ticks */}
          {[0, 1, 2, 3].map((rate) => {
            const y = BASAL_CHART_HEIGHT - (rate / 3) * BASAL_CHART_HEIGHT;
            return (
              <g key={`basal-tick-${rate}`}>
                <line
                  x1={0}
                  x2={innerWidth}
                  y1={y}
                  y2={y}
                  stroke="var(--grid-line)"
                  strokeWidth={0.5}
                />
                <text
                  x={-4}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="central"
                  fill="var(--text-secondary)"
                  fontSize={9}
                  fontFamily="var(--font-geist-mono)"
                  opacity={0.6}
                >
                  {rate}
                </text>
              </g>
            );
          })}

          {/* X-axis (shared time axis at bottom of basal panel) */}
          <AxisBottom
            scale={xScale}
            top={BASAL_CHART_HEIGHT}
            stroke="var(--border)"
            tickStroke="var(--border)"
            tickLabelProps={() => ({
              fill: "var(--text-secondary)",
              fontSize: 11,
              fontFamily: "var(--font-geist-mono)",
              textAnchor: "middle" as const,
              dy: 4,
            })}
          />
        </Group>
      </svg>

      {/* Tooltip — rendered as portal to avoid scroll container clipping */}
      {tooltipOpen && tooltipData && typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed z-50 pointer-events-none bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg shadow-xl px-3 py-2"
            style={{
              left: tooltipPos.x + 12,
              top: tooltipPos.y - 8,
              color: "var(--foreground)",
              fontSize: 13,
              fontFamily: "var(--font-geist-sans)",
            }}
          >
            {tooltipData.kind === "glucose" && (
              <>
                <div className="flex items-baseline gap-2">
                  <span
                    className={`text-lg font-semibold tabular-nums ${glucoseColorClass(tooltipData.data.sgv)}`}
                  >
                    {tooltipData.data.sgv}
                  </span>
                  <span className="text-[var(--text-secondary)]">
                    {TREND_ARROWS[tooltipData.data.direction]}
                  </span>
                </div>
                <div className="text-xs text-[var(--text-secondary)] font-[family-name:var(--font-geist-mono)]">
                  {new Date(tooltipData.data.date).toLocaleTimeString(
                    [],
                    { hour: "numeric", minute: "2-digit" }
                  )}
                </div>
              </>
            )}
            {tooltipData.kind === "bolus" && (
              <>
                <div className="flex items-baseline gap-1">
                  <span className="text-lg font-semibold tabular-nums text-[var(--insulin-blue)]">
                    {tooltipData.data.insulin}U
                  </span>
                  <span className="text-xs text-[var(--text-secondary)]">
                    bolus
                  </span>
                </div>
                <div className="text-xs text-[var(--text-secondary)] font-[family-name:var(--font-geist-mono)]">
                  {new Date(
                    treatmentTime(tooltipData.data)
                  ).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
              </>
            )}
            {tooltipData.kind === "carb" && (
              <>
                <div className="flex items-baseline gap-1">
                  <span className="text-lg font-semibold tabular-nums text-[var(--carb-amber)]">
                    {tooltipData.data.carbs}g
                  </span>
                  <span className="text-xs text-[var(--text-secondary)]">
                    carbs
                  </span>
                </div>
                <div className="text-xs text-[var(--text-secondary)] font-[family-name:var(--font-geist-mono)]">
                  {new Date(
                    treatmentTime(tooltipData.data)
                  ).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

// Minimum pixels per hour — ensures readability and enables scrolling on longer ranges
const MIN_PX_PER_HOUR = 80;

export function GlucoseChart({
  readings,
  boluses = [],
  carbs = [],
  basals = [],
  predictions = [],
  height = 440,
}: GlucoseChartProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevReadingsLen = useRef(0);

  // Auto-scroll to the right (most recent) when data or range changes.
  // Uses requestAnimationFrame to wait for ParentSize to render the
  // scrollable content — without it, scrollWidth is still 0.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      // Double-RAF ensures the browser has painted the inner chart
      requestAnimationFrame(() => {
        el.scrollLeft = el.scrollWidth;
      });
    });
    prevReadingsLen.current = readings.length;
    return () => cancelAnimationFrame(raf);
  }, [readings]);

  return (
    <ParentSize>
      {({ width: containerWidth }) => {
        if (containerWidth <= 0) return null;

        // Calculate how many hours of data we have (including predictions)
        const sorted = [...readings].sort((a, b) => a.date - b.date);
        const dataEnd = sorted.length > 1 ? sorted[sorted.length - 1].date : Date.now();
        const predEnd = predictions.length > 0 ? predictions[predictions.length - 1].timestamp : dataEnd;
        const hoursSpan =
          sorted.length > 1
            ? (Math.max(dataEnd, predEnd) - sorted[0].date) / 3_600_000
            : 3;

        // Calculate minimum width needed for readable density
        const minWidth = Math.max(
          containerWidth,
          hoursSpan * MIN_PX_PER_HOUR + margin.left + margin.right
        );

        const isScrollable = minWidth > containerWidth;

        // Compute Y scale here so the sticky axis can share it
        const glucoseHeight =
          height -
          margin.top -
          TREATMENT_LANE_HEIGHT -
          BASAL_GAP -
          BASAL_CHART_HEIGHT -
          BASAL_MARGIN_BOTTOM -
          margin.bottom;

        const yScale = scaleLinear({
          domain: [Y_MIN, Y_MAX],
          range: [glucoseHeight, 0],
          nice: true,
        });

        return (
          <div className="relative">
            {/* Sticky Y-axis overlay — stays fixed when scrolling */}
            {isScrollable && (
              <svg
                width={margin.left}
                height={height}
                className="absolute left-0 top-0 z-[5] pointer-events-none"
                style={{ background: "var(--bg-surface)" }}
              >
                <Group left={margin.left - 1} top={margin.top + TREATMENT_LANE_HEIGHT}>
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
                </Group>
                {/* Basal Y-axis label */}
                <Group left={margin.left - 1} top={margin.top + TREATMENT_LANE_HEIGHT + glucoseHeight + BASAL_GAP}>
                  <text
                    x={-8}
                    y={BASAL_CHART_HEIGHT / 2}
                    textAnchor="end"
                    dominantBaseline="central"
                    fill="var(--text-secondary)"
                    fontSize={10}
                    fontFamily="var(--font-geist-mono)"
                  >
                    U/hr
                  </text>
                </Group>
              </svg>
            )}
            <div
              ref={scrollRef}
              className={`${isScrollable ? "overflow-x-auto" : ""}`}
              style={{
                WebkitOverflowScrolling: "touch",
                scrollbarWidth: "thin",
                scrollbarColor: "var(--border) transparent",
              }}
            >
              <Chart
                readings={readings}
                boluses={boluses}
                carbs={carbs}
                basals={basals}
                predictions={predictions}
                width={minWidth}
                height={height}
              />
            </div>
          </div>
        );
      }}
    </ParentSize>
  );
}
