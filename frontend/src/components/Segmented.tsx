/** A pill group, same shape as the asset picker in SendForm. Radios rather
 *  than a select: the options are few and worth seeing at once, and a native
 *  select's open list is drawn by the OS, so it arrives grey and square no
 *  matter what this file says. Radios keep the form working without client JS
 *  and keep arrow-key navigation within the group. */
export default function Segmented({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  return (
    // Not a flex fieldset: a legend is laid out by its own rules and browsers
    // disagree about where it lands inside one. Default block flow, with the
    // row of pills doing the flexing.
    <fieldset>
      <legend className="mb-1 p-0 text-xs text-graphite">{label}</legend>
      <div className="flex rounded-full border border-fog p-1">
        {options.map((o) => (
          <label key={o.value} className="relative">
            <input
              type="radio"
              name={name}
              value={o.value}
              defaultChecked={value === o.value}
              className="peer sr-only"
            />
            <span
              className="block cursor-pointer rounded-full px-3.5 py-1.5 text-sm font-medium text-graphite transition-colors hover:text-ink peer-checked:bg-ink peer-checked:text-paper peer-focus-visible:ring-2 peer-focus-visible:ring-ink/30"
            >
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
