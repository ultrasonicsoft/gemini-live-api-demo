import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { AudioEngine } from '../live/audio-engine.service';
import { LiveSession } from '../live/live-session.service';

type Tab = 'events' | 'setup' | 'prompt';

@Component({
  selector: 'app-insights',
  templateUrl: './insights.html',
})
export class Insights {
  protected readonly live = inject(LiveSession);
  protected readonly audio = inject(AudioEngine);
  private readonly http = inject(HttpClient);

  protected readonly tab = signal<Tab>('events');
  protected readonly setup = signal<any>(null);
  protected readonly setupJson = computed(() => {
    const setup = this.setup();
    if (!setup) return '';
    const copy = structuredClone(setup);
    if (copy.systemInstruction) copy.systemInstruction = '(see the Prompt tab)';
    return JSON.stringify(copy, null, 2);
  });
  protected readonly promptText = computed(() => this.setup()?.systemInstruction?.parts?.[0]?.text ?? '');
  protected readonly maxLatency = computed(() => Math.max(1000, ...this.live.latencies()));

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect((onCleanup) => {
      const settings = this.live.settings();
      timer = setTimeout(() => {
        this.http.post('/api/setup-preview', settings).subscribe((value) => this.setup.set(value));
      }, 150);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected ms(value: number | null): string {
    return value === null ? '–' : `${value} ms`;
  }
}
