import { useMemo, useRef } from "react";
import { Calendar, Clock } from "lucide-react";

/**
 * Cross-browser combined date + time picker.
 * Emits/consumes `YYYY-MM-DDTHH:mm` (same shape as <input type="datetime-local">).
 *
 * Uses native <input type="date"> (rock-solid in Firefox/Chrome/Safari — calendar-only
 * picker is the expected behavior) plus custom time controls to avoid Firefox
 * datetime-local bugs 1726108 (missing time picker) and 1990226 (empty time picker
 * when min/max is set).
 */

type Props = {
  value: string; // "YYYY-MM-DDTHH:mm" or ""
  onChange: (v: string) => void;
  min?: string; // "YYYY-MM-DDTHH:mm"
  disabled?: boolean;
  id?: string;
};

function parts(v: string) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(v || "");
  if (!m) return { date: "", hh: "", mm: "" };
  return { date: m[1], hh: m[2], mm: m[3] };
}

function join(date: string, hh: string, mm: string) {
  if (!date) return "";
  const H = (hh || "00").padStart(2, "0");
  const M = (mm || "00").padStart(2, "0");
  return `${date}T${H}:${M}`;
}

export default function DateTimePicker({ value, onChange, min, disabled, id }: Props) {
  const { date, hh, mm } = parts(value);
  const minP = parts(min || "");
  const dateRef = useRef<HTMLInputElement>(null);

  // On the same day as `min`, disallow earlier times.
  const sameAsMinDay = min && date && date === minP.date;
  const minHour = sameAsMinDay ? parseInt(minP.hh || "0", 10) : 0;
  const minMinute = sameAsMinDay && parseInt(hh || "0", 10) === minHour
    ? parseInt(minP.mm || "0", 10)
    : 0;

  // Convert stored 24h -> display 12h.
  const h24 = parseInt(hh || "", 10);
  const isPM = !isNaN(h24) && h24 >= 12;
  const h12 = isNaN(h24) ? "" : String(((h24 + 11) % 12) + 1).padStart(2, "0");
  const period: "AM" | "PM" = isPM ? "PM" : "AM";

  const hours12 = useMemo(() => Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")), []);
  const minutes = useMemo(() => Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")), []);

  function emit(nextDate: string, nextH12: string, nextMin: string, nextPeriod: "AM" | "PM") {
    if (!nextDate) { onChange(""); return; }
    let h = parseInt(nextH12 || "12", 10);
    if (isNaN(h)) h = 12;
    if (nextPeriod === "AM") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
    let m = parseInt(nextMin || "0", 10);
    if (isNaN(m)) m = 0;

    // Clamp to min if same-day
    if (min) {
      const mp = parts(min);
      if (nextDate === mp.date) {
        const minH = parseInt(mp.hh, 10);
        const minM = parseInt(mp.mm, 10);
        if (h < minH || (h === minH && m < minM)) {
          h = minH;
          m = minM;
        }
      }
    }
    onChange(join(nextDate, String(h).padStart(2, "0"), String(m).padStart(2, "0")));
  }

  const baseField =
    "bg-slate-50 border border-slate-200 rounded-xl px-3 h-11 outline-none focus:ring-2 focus:ring-amber-500 text-sm text-slate-900";

  return (
    <div id={id} className="flex flex-wrap items-stretch gap-2">
      {/* Date */}
      <div className="relative flex-1 min-w-[150px]">
        <Calendar className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          ref={dateRef}
          type="date"
          value={date}
          min={min ? parts(min).date : undefined}
          disabled={disabled}
          onChange={(e) => emit(e.target.value, h12 || "12", mm || "00", period)}
          className={`${baseField} pl-9 pr-2 w-full`}
          aria-label="Date"
        />
      </div>

      {/* Time */}
      <div
        role="group"
        aria-label="Time"
        className="flex items-stretch gap-1 bg-slate-50 border border-slate-200 rounded-xl px-2 h-11"
      >
        <Clock className="w-4 h-4 text-slate-400 self-center" />
        <select
          value={h12}
          disabled={disabled || !date}
          onChange={(e) => emit(date, e.target.value, mm || "00", period)}
          className="bg-transparent outline-none text-sm text-slate-900 px-1 h-full appearance-none cursor-pointer disabled:opacity-50"
          aria-label="Hour"
        >
          {!h12 && <option value="">--</option>}
          {hours12.map((h) => {
            const asH24 = period === "AM"
              ? (h === "12" ? 0 : parseInt(h, 10))
              : (h === "12" ? 12 : parseInt(h, 10) + 12);
            const disabledOpt = sameAsMinDay && asH24 < minHour;
            return (
              <option key={h} value={h} disabled={disabledOpt}>{h}</option>
            );
          })}
        </select>
        <span className="self-center text-slate-400 text-sm">:</span>
        <select
          value={mm}
          disabled={disabled || !date}
          onChange={(e) => emit(date, h12 || "12", e.target.value, period)}
          className="bg-transparent outline-none text-sm text-slate-900 px-1 h-full appearance-none cursor-pointer disabled:opacity-50"
          aria-label="Minute"
        >
          {!mm && <option value="">--</option>}
          {minutes.map((m) => {
            const mi = parseInt(m, 10);
            const disabledOpt = !!(sameAsMinDay && parseInt(h12 || "0", 10) && mi < minMinute);
            return (
              <option key={m} value={m} disabled={disabledOpt}>{m}</option>
            );
          })}
        </select>

        {/* AM / PM segmented toggle */}
        <div className="flex items-center gap-0.5 ml-1 bg-white/60 border border-slate-200 rounded-lg p-0.5 self-center">
          {(["AM", "PM"] as const).map((p) => (
            <button
              key={p}
              type="button"
              disabled={disabled || !date}
              onClick={() => emit(date, h12 || "12", mm || "00", p)}
              className={
                "text-[11px] font-semibold px-2 py-1 rounded-md transition-colors " +
                (period === p
                  ? "bg-amber-500 text-white shadow-sm"
                  : "text-slate-500 hover:text-slate-800")
              }
              aria-pressed={period === p}
              aria-label={p}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
