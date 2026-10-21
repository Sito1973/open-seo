import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import {
  DataTableFilterGroup,
  DataTableFilterPanel,
  DataTableRangeFilter,
} from "@/client/components/table/DataTableToolbar";
import { Input } from "@/client/components/ui/input";
import type { CitationTab } from "@/client/features/ai-search/brandLookupFilterTypes";
import { formatPlatformLabel } from "@/client/features/ai-search/platformLabels";
import type { BrandLookupFiltersState } from "@/client/features/ai-search/useBrandLookupFilters";
import type { BrandLookupPlatform } from "@/types/schemas/ai-search";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyForm = { Field: React.ComponentType<any> };

type StringField = {
  state: { value: string };
  handleChange: (v: string) => void;
};

function FilterTextInput({
  form,
  name,
  label,
  placeholder,
}: {
  form: AnyForm;
  name: string;
  label: string;
  placeholder: string;
}) {
  return (
    <DataTableFilterGroup label={label}>
      <form.Field name={name}>
        {(field: StringField) => (
          <Input
            className="h-7"
            aria-label={label}
            placeholder={placeholder}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
          />
        )}
      </form.Field>
    </DataTableFilterGroup>
  );
}

function FilterRangeInputs({
  form,
  title,
  minName,
  maxName,
}: {
  form: AnyForm;
  title: string;
  minName: string;
  maxName: string;
}) {
  return (
    <form.Field name={minName}>
      {(minField: StringField) => (
        <form.Field name={maxName}>
          {(maxField: StringField) => (
            <DataTableRangeFilter
              label={title}
              min={{
                value: minField.state.value,
                onChange: (event) => minField.handleChange(event.target.value),
              }}
              max={{
                value: maxField.state.value,
                onChange: (event) => maxField.handleChange(event.target.value),
              }}
            />
          )}
        </form.Field>
      )}
    </form.Field>
  );
}

function PlatformToggle({
  form,
  platforms,
}: {
  form: AnyForm;
  platforms: BrandLookupPlatform[];
}) {
  return (
    <DataTableFilterGroup label="Platform">
      <form.Field name="platform">
        {(field: StringField) => (
          <SegmentedToggle
            showLabels
            items={[
              { value: "all", icon: null, label: "All" },
              ...platforms.map((platform) => ({
                value: platform,
                icon: null,
                label: formatPlatformLabel(platform),
              })),
            ]}
            // The stored value for "All" is the empty string.
            value={field.state.value || "all"}
            onChange={(value) =>
              field.handleChange(value === "all" ? "" : value)
            }
          />
        )}
      </form.Field>
    </DataTableFilterGroup>
  );
}

function TopPagesFilters({
  form,
  platforms,
}: {
  form: BrandLookupFiltersState["pages"]["form"];
  platforms: BrandLookupPlatform[];
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        <FilterTextInput
          form={form}
          name="include"
          label="Include Terms"
          placeholder="reddit, forbes"
        />
        <FilterTextInput
          form={form}
          name="exclude"
          label="Exclude Terms"
          placeholder="pinterest, /tag"
        />
      </div>

      <div className="flex flex-wrap items-stretch gap-2">
        <PlatformToggle form={form} platforms={platforms} />
        <div className="min-w-[220px]">
          <FilterRangeInputs
            form={form}
            title="Source mentions"
            minName="minMentions"
            maxName="maxMentions"
          />
        </div>
      </div>
    </>
  );
}

function QueriesFilters({
  form,
  platforms,
  showVolume,
}: {
  form: BrandLookupFiltersState["queries"]["form"];
  platforms: BrandLookupPlatform[];
  showVolume: boolean;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        <FilterTextInput
          form={form}
          name="include"
          label="Include Terms"
          placeholder="pricing, reviews"
        />
        <FilterTextInput
          form={form}
          name="exclude"
          label="Exclude Terms"
          placeholder="login, download"
        />
      </div>

      <div className="flex flex-wrap items-stretch gap-2">
        <PlatformToggle form={form} platforms={platforms} />
        {showVolume ? (
          <div className="min-w-[220px]">
            <FilterRangeInputs
              form={form}
              title="AI search volume"
              minName="minVolume"
              maxName="maxVolume"
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

export function BrandLookupFilterPanel({
  activeTab,
  filters,
  platforms,
  showVolume,
}: {
  activeTab: CitationTab;
  filters: BrandLookupFiltersState;
  /** The platforms the lookup covered, for the platform toggle. */
  platforms: BrandLookupPlatform[];
  showVolume: boolean;
}) {
  const current = filters[activeTab];

  return (
    <DataTableFilterPanel
      activeCount={current.activeFilterCount}
      onReset={current.reset}
    >
      {activeTab === "pages" ? (
        <TopPagesFilters form={filters.pages.form} platforms={platforms} />
      ) : (
        <QueriesFilters
          form={filters.queries.form}
          platforms={platforms}
          showVolume={showVolume}
        />
      )}
    </DataTableFilterPanel>
  );
}
