import { useId, useState, type PointerEvent } from "react";

import { formatElapsed } from "@/lib/metrics";

/**
 * A dependency-free SVG time-series chart for one measure family: one y-axis, at most two
 * series, an optional dashed reference line (what the Attempt was allotted), and a crosshair
 * that reads every series at the hovered bucket.
 *
 * The two series colours were checked with the dataviz palette validator against the card
 * surface (#0d0d0f, dark): both inside the lightness band, deutan separation ΔE 23.
 */
export const SERIES_COLORS = ["#059669", "#8b5cf6"] as const;

/** The first series is drawn as an area, a second one as a line over it. */
export type ChartSeries = {
  name: string;
  values: Array<number | undefined>;
};

const WIDTH = 640;
const HEIGHT = 168;
const PAD = { top: 10, right: 12, bottom: 22, left: 64 };

/**
 * A round axis top at or above value. Byte measures round in binary units, so a 16 GiB limit
 * reads against 0, 10 and 20 GiB rather than 0, 9.3 and 18.6.
 */
function niceCeiling(value: number, binary: boolean): number {
  if (value <= 0) return 1;
  if (binary && value >= 1024) {
    const unit = 1024 ** Math.floor(Math.log(value) / Math.log(1024));
    return niceCeiling(value / unit, false) * unit;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

export function MetricChart({
  title,
  seconds,
  series,
  reference,
  format,
  binary = false,
}: {
  title: string;
  seconds: number[];
  series: ChartSeries[];
  reference?: { label: string; value: number };
  format: (value: number) => string;
  /** The measure is bytes or bytes per second. */
  binary?: boolean;
}) {
  const clipId = useId();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const last = seconds.length > 0 ? seconds[seconds.length - 1]! : 0;
  const span = Math.max(last, 1);
  const peak = Math.max(
    reference?.value ?? 0,
    ...series.flatMap((line) => line.values.map((value) => value ?? 0)),
  );
  const yMax = niceCeiling(peak * 1.05, binary);
  const x = (second: number) => PAD.left + (second / span) * plotWidth;
  const y = (value: number) => PAD.top + plotHeight - (value / yMax) * plotHeight;
  const baseline = y(0);

  const path = (values: Array<number | undefined>) =>
    values
      .map((value, index) => `${index === 0 ? "M" : "L"}${x(seconds[index]!)},${y(value ?? 0)}`)
      .join(" ");

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (seconds.length === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const second =
      ((((event.clientX - box.left) / box.width) * WIDTH - PAD.left) / plotWidth) * span;
    let nearest = 0;
    for (let index = 1; index < seconds.length; index += 1) {
      if (Math.abs(seconds[index]! - second) < Math.abs(seconds[nearest]! - second))
        nearest = index;
    }
    setHover(nearest);
  };

  const ticks = [0, yMax / 2, yMax];
  return (
    <figure className="min-w-0 rounded-lg border border-border bg-card p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {series.length > 1 && (
          <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {series.map((line, index) => (
              <span key={line.name} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-0.5 w-3 rounded-full"
                  style={{ backgroundColor: SERIES_COLORS[index] }}
                />
                {line.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="relative mt-3">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block h-auto w-full touch-none select-none"
          role="img"
          aria-label={`${title} over the Attempt`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(undefined)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.left} y={PAD.top} width={plotWidth} height={plotHeight} />
            </clipPath>
          </defs>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-subtle-foreground text-[10px] tabular-nums"
              >
                {format(tick)}
              </text>
            </g>
          ))}
          {[0, span / 2, span].map((second, index) => (
            <text
              key={second}
              x={x(second)}
              y={HEIGHT - 6}
              textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"}
              className="fill-subtle-foreground text-[10px] tabular-nums"
            >
              {formatElapsed(second)}
            </text>
          ))}
          <g clipPath={`url(#${clipId})`}>
            {series[0] !== undefined && seconds.length > 0 && (
              <>
                <path
                  d={`${path(series[0].values)} L${x(seconds[seconds.length - 1]!)},${baseline} L${x(seconds[0]!)},${baseline} Z`}
                  fill={SERIES_COLORS[0]}
                  fillOpacity={0.22}
                />
                <path
                  d={path(series[0].values)}
                  fill="none"
                  stroke={SERIES_COLORS[0]}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              </>
            )}
            {series[1] !== undefined && seconds.length > 0 && (
              <path
                d={path(series[1].values)}
                fill="none"
                stroke={SERIES_COLORS[1]}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            )}
          </g>
          {reference !== undefined && (
            <g>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(reference.value)}
                y2={y(reference.value)}
                stroke="var(--muted-foreground)"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              <text
                x={WIDTH - PAD.right}
                y={y(reference.value) - 4}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {reference.label}
              </text>
            </g>
          )}
          {hover !== undefined && (
            <line
              x1={x(seconds[hover]!)}
              x2={x(seconds[hover]!)}
              y1={PAD.top}
              y2={baseline}
              stroke="var(--muted-foreground)"
              strokeWidth={1}
            />
          )}
        </svg>
        {hover !== undefined && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] shadow-lg"
            style={
              x(seconds[hover]!) > WIDTH / 2
                ? { right: `${(1 - (x(seconds[hover]!) - 8) / WIDTH) * 100}%` }
                : { left: `${((x(seconds[hover]!) + 8) / WIDTH) * 100}%` }
            }
          >
            <p className="mb-1 tabular-nums text-subtle-foreground">
              {formatElapsed(seconds[hover]!)}
            </p>
            {series.map((line, index) => (
              <p key={line.name} className="flex items-center gap-2">
                <span
                  className="inline-block h-0.5 w-3 rounded-full"
                  style={{ backgroundColor: SERIES_COLORS[index] }}
                />
                <span className="font-medium tabular-nums text-foreground">
                  {line.values[hover] === undefined ? "–" : format(line.values[hover]!)}
                </span>
                <span className="text-muted-foreground">{line.name}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
