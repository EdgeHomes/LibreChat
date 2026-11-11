import React, { useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { HoverCard, HoverCardTrigger, HoverCardPortal, HoverCardContent } from '@librechat/client';
import type { TModelSpec, TModelSpecRating } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type Metric = 'speed' | 'complexity' | 'cost';

/** The rating that is good news for each metric; it shows as success, `medium` as warning, the rest as error. */
const METRICS: { key: Metric; labelKey: TranslationKeys; good: TModelSpecRating }[] = [
  { key: 'speed', labelKey: 'com_ui_model_speed', good: 'high' },
  { key: 'complexity', labelKey: 'com_ui_model_complexity', good: 'high' },
  { key: 'cost', labelKey: 'com_ui_model_cost', good: 'low' },
];

const RATING_KEYS: Record<TModelSpecRating, TranslationKeys> = {
  low: 'com_ui_low',
  medium: 'com_ui_medium',
  high: 'com_ui_high',
};

function ratingClass(rating: TModelSpecRating, good: TModelSpecRating) {
  if (rating === good) {
    return 'text-status-success';
  }
  return rating === 'medium' ? 'text-status-warning' : 'text-status-error';
}

export default function SpecHelp({ spec }: { spec: TModelSpec }) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const help = spec.helpText;
  if (!help) {
    return null;
  }

  const rows = METRICS.filter(({ key }) => help[key] != null);
  /** Keeps the click and Enter/Space from also selecting the surrounding menu item. */
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <HoverCard openDelay={100} open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={localize('com_ui_model_info', { 0: spec.label })}
          onClick={(e) => {
            stop(e);
            setOpen((prev) => !prev);
          }}
          onKeyDown={stop}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className="hover:bg-surface-hover focus-visible:ring-ring-primary text-text-secondary cursor-help rounded-md p-1 focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset"
        >
          <CircleHelp className="h-4 w-4" aria-hidden="true" />
        </button>
      </HoverCardTrigger>
      <HoverCardPortal>
        <HoverCardContent side="right" className="z-[999] w-60">
          <p className="text-text-primary mb-2 text-sm font-semibold">{spec.label}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {rows.map(({ key, labelKey, good }) => {
              const rating = help[key] as TModelSpecRating;
              return (
                <React.Fragment key={key}>
                  <dt className="text-text-primary font-semibold">{localize(labelKey)}</dt>
                  <dd className={cn('font-semibold', ratingClass(rating, good))}>
                    {localize(RATING_KEYS[rating])}
                  </dd>
                </React.Fragment>
              );
            })}
          </dl>
          {help.notes && <p className="text-text-secondary mt-2 text-xs">{help.notes}</p>}
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}
