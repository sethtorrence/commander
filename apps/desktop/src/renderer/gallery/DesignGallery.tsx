import { SectionHeader, Sheet, SignalColourPicker, ThemeToggle } from '@commander/ui';
import { ButtonsSpecimen, FieldsSpecimen, MarksSpecimen, OverlaysSpecimen } from './components';
import { Plate } from './Plate';
import { DrawingSpecimen, SectionHeaderSizes, SectionHeaderSpecimen } from './sheets';
import { AccentTokens, ColourTokens } from './tokens';
import { RulesSpecimen, TypeSpecimen } from './type-and-rules';

/**
 * The design gallery: every token and component of the Industrial design system, in both themes,
 * for checking side by side against the prototype screenshots.
 */
export function DesignGallery() {
  return (
    <main data-testid="design-gallery" className="min-h-screen bg-bg p-3.5">
      <Sheet margin>
        <SectionHeader
          size="dashboard"
          eyebrow="Design"
          partNumber="DSG-2026-276"
          sheet={[1, 1]}
          title="Design gallery"
          subtitle={
            <>
              Every token and component, <b>dark and light</b>, from the locked prototypes
            </>
          }
          aside={
            <div className="flex items-center gap-2">
              <a
                href="#/"
                className="flex h-7.5 items-center border border-line px-2.5 font-mono text-label leading-none font-semibold uppercase tracking-caps text-muted no-underline hover:border-ink hover:text-ink"
              >
                Back
              </a>
              <ThemeToggle />
            </div>
          }
        />
        <section aria-label="Signal colour setting" className="border-b border-line py-4 pr-5 pl-13">
          <SignalColourPicker className="max-w-[820px]" />
        </section>

        <Plate no="01" title="Colour" note="Tokens · per theme">
          {() => <ColourTokens />}
        </Plate>
        <Plate no="02" title="Project accents" note="Badges · 3:1 on both sheets">
          {(theme) => <AccentTokens theme={theme} />}
        </Plate>
        <Plate no="03" title="Type" note="Archivo · IBM Plex Mono">
          {() => <TypeSpecimen />}
        </Plate>
        <Plate no="04" title="Rules and metrics" note="Spacing · rules">
          {() => <RulesSpecimen />}
        </Plate>
        <Plate no="05" title="Buttons" note="Button · ButtonGroup">
          {() => <ButtonsSpecimen />}
        </Plate>
        <Plate no="06" title="Fields" note="Input · Select">
          {(theme) => <FieldsSpecimen theme={theme} />}
        </Plate>
        <Plate no="07" title="Overlays" note="Dialog · Tooltip · Toast">
          {(theme) => <OverlaysSpecimen theme={theme} />}
        </Plate>
        <Plate no="08" title="Marks" note="Kbd · Led">
          {() => <MarksSpecimen />}
        </Plate>
        <Plate no="09" title="Drawing sheet with rulers" note="Drawing · Sheet · SheetStrip" stacked>
          {() => <DrawingSpecimen />}
        </Plate>
        <Plate no="10" title="Section header" note="SectionHeader · part-number label" stacked>
          {() => (
            <>
              <SectionHeaderSpecimen />
              <SectionHeaderSizes />
            </>
          )}
        </Plate>
      </Sheet>
    </main>
  );
}
