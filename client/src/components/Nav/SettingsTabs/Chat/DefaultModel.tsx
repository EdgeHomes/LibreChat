import { useAtom } from 'jotai';
import { Dropdown } from '@librechat/client';
import { defaultModelSpecAtom } from '~/store/defaultModel';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

/** Ariakit's select treats `''` as no selection, so the config default gets a sentinel. */
const ORG_DEFAULT = '__org_default__';

export default function DefaultModelSelector() {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const [specName, setSpecName] = useAtom(defaultModelSpecAtom);
  const list = startupConfig?.modelSpecs?.list ?? [];

  const options = [
    { value: ORG_DEFAULT, label: localize('com_nav_default_model_org') },
    ...list.map((spec) => ({
      value: spec.name,
      label: spec.group ? `${spec.group} · ${spec.label}` : spec.label,
    })),
  ];
  const value = list.some((spec) => spec.name === specName) ? specName : ORG_DEFAULT;
  const labelId = 'default-model-selector-label';

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div id={labelId}>{localize('com_nav_default_model')}</div>
      <Dropdown
        value={value}
        options={options}
        onChange={(next) => setSpecName(next === ORG_DEFAULT ? '' : next)}
        testId="default-model-selector"
        sizeClasses="w-[220px]"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
}
