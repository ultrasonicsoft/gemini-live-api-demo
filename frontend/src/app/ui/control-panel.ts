import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { LiveSession } from '../live/live-session.service';
import { BASELINE, DemoSettings, EXPERIMENTS, Experiment, OptionsResponse } from '../live/models';

@Component({
  selector: 'app-control-panel',
  templateUrl: './control-panel.html',
})
export class ControlPanel {
  protected readonly live = inject(LiveSession);
  protected readonly options = toSignal(inject(HttpClient).get<OptionsResponse>('/api/options'));
  protected readonly s = this.live.settings;
  protected readonly activeId = signal('baseline');

  protected readonly groups = ['Latency', 'Interruption', 'Voice style', 'Security', 'Sessions'].map((name) => ({
    name,
    items: EXPERIMENTS.filter((e) => e.group === name),
  }));
  protected readonly active = computed(() => EXPERIMENTS.find((e) => e.id === this.activeId()));
  protected readonly thinkingLevels = computed(
    () => this.options()?.models.find((m) => m.id === this.s().model)?.thinkingLevels ?? [],
  );
  protected readonly modelNote = computed(() => this.options()?.models.find((m) => m.id === this.s().model)?.note ?? '');

  protected apply(experiment: Experiment): void {
    const { mode, model, voice, scenario } = this.s();
    this.activeId.set(experiment.id);
    this.live.settings.set({ ...BASELINE, mode, model, voice, scenario, ...experiment.patch });
    if (this.live.isActive() && this.live.needsReconnect()) void this.live.restart();
  }

  protected set<K extends keyof DemoSettings>(key: K, value: DemoSettings[K]): void {
    this.live.patch({ [key]: value } as Partial<DemoSettings>);
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected num(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}
