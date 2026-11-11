import { useSetAtom } from 'jotai';
import { Dropdown, useToastContext } from '@librechat/client';
import {
  useGetStartupConfig,
  useGetUserQuery,
  useUpdateUserPreferencesMutation,
} from '~/data-provider';
import { defaultModelSpecAtom } from '~/store/defaultModel';
import { useLocalize } from '~/hooks';

/** Ariakit's select treats `''` as no selection, so the config default gets a sentinel. */
const ORG_DEFAULT = '__org_default__';

export default function DefaultModelSelector() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: startupConfig } = useGetStartupConfig();
  const { data: user } = useGetUserQuery();
  const setMirror = useSetAtom(defaultModelSpecAtom);
  const list = startupConfig?.modelSpecs?.list ?? [];
  const saved = user?.personalization?.defaultModelSpec ?? '';

  const mutation = useUpdateUserPreferencesMutation({
    onSuccess: (data) => {
      setMirror(data.preferences.defaultModelSpec ?? '');
      showToast({ message: localize('com_ui_preferences_updated'), status: 'success' });
    },
    onError: () =>
      showToast({ message: localize('com_ui_error_updating_preferences'), status: 'error' }),
  });

  const options = [
    { value: ORG_DEFAULT, label: localize('com_nav_default_model_org') },
    ...list.map((spec) => ({
      value: spec.name,
      label: spec.group ? `${spec.group} · ${spec.label}` : spec.label,
    })),
  ];
  const pending = mutation.isLoading ? mutation.variables?.defaultModelSpec : undefined;
  const current = pending ?? saved;
  const value = list.some((spec) => spec.name === current) ? current : ORG_DEFAULT;
  const labelId = 'default-model-selector-label';

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div id={labelId}>{localize('com_nav_default_model')}</div>
      <Dropdown
        value={value}
        options={options}
        onChange={(next) => mutation.mutate({ defaultModelSpec: next === ORG_DEFAULT ? '' : next })}
        disabled={mutation.isLoading}
        testId="default-model-selector"
        sizeClasses="w-[220px]"
        className="z-50"
        aria-labelledby={labelId}
      />
    </div>
  );
}
