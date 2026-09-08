import { useId, type JSX } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WorkflowRunInputOption } from "./workflow-page-types.js";

export function WorkflowRunInputField({ input, value, error, disabled, onChange }: {
  input: WorkflowRunInputOption;
  value: string | string[] | boolean | undefined;
  error?: string;
  disabled: boolean;
  onChange: (value: string | string[] | boolean) => void;
}): JSX.Element {
  const id = useId();
  const label = input.label || input.key;
  const errorId = `${id}-error`;
  const accessibility = { "aria-invalid": error ? true : undefined, "aria-describedby": error ? errorId : undefined } as const;
  const errorMessage = error ? <p id={errorId} className="text-sm text-destructive" role="alert">{error}</p> : null;

  if (input.deriveFrom) {
    return <div className="space-y-1 text-sm">
      <p className="font-medium">{label}</p>
      <p className="text-muted-foreground">{input.deriveFrom.input}에서 자동으로 추출됩니다.</p>
      {errorMessage}
    </div>;
  }

  if (input.type === "radio" || input.type === "checkbox") {
    const selected = Array.isArray(value) ? value : [];
    return <fieldset disabled={disabled} className="space-y-2" {...accessibility}>
      <legend className="text-sm font-medium">{label}</legend>
      {input.options.map((option, index) => {
        const optionId = `${id}-${index}`;
        return <div key={option.value} className="flex items-center gap-2">
          {input.type === "radio" ? <input
            id={optionId} type="radio" name={id} value={option.value}
            checked={value === option.value} disabled={disabled} {...accessibility}
            onChange={() => onChange(option.value)} className="size-4 accent-primary"
          /> : <Checkbox
            id={optionId} checked={selected.includes(option.value)} disabled={disabled} {...accessibility}
            onCheckedChange={(checked) => onChange(checked === true
              ? [...selected.filter((item) => item !== option.value), option.value]
              : selected.filter((item) => item !== option.value))}
          />}
          <Label htmlFor={optionId}>{option.label}</Label>
        </div>;
      })}
      {errorMessage}
    </fieldset>;
  }

  if (input.type === "switch") {
    return <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button id={id} type="button" role="switch" aria-checked={value === true}
          disabled={disabled} {...accessibility} onClick={() => onChange(value !== true)}
          className="inline-flex h-6 w-11 shrink-0 items-center rounded-full border bg-muted px-0.5 transition-colors aria-checked:bg-primary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
          <span aria-hidden="true" className={`size-5 rounded-full bg-background shadow transition-transform ${value === true ? "translate-x-4" : "translate-x-0"}`} />
        </button>
        <Label htmlFor={id}>{label}</Label>
      </div>
      {errorMessage}
    </div>;
  }

  return <div className="space-y-2">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} value={typeof value === "string" ? value : ""} disabled={disabled}
      {...accessibility} onChange={(event) => onChange(event.target.value)} />
    {errorMessage}
  </div>;
}
