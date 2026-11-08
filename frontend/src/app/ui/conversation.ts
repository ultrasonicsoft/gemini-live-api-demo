import { HttpClient } from '@angular/common/http';
import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { AudioEngine } from '../live/audio-engine.service';
import { LiveSession } from '../live/live-session.service';
import { ATTACKS, OptionsResponse } from '../live/models';

const PHASE_LABELS: Record<string, string> = {
  idle: 'Ready',
  connecting: 'Connecting',
  listening: 'Listening',
  'ai-speaking': 'Maya is speaking',
  reconnecting: 'Reconnecting',
  error: 'Stopped',
};

@Component({
  selector: 'app-conversation',
  templateUrl: './conversation.html',
})
export class Conversation {
  protected readonly live = inject(LiveSession);
  protected readonly audio = inject(AudioEngine);
  protected readonly attacks = ATTACKS;
  private readonly options = toSignal(inject(HttpClient).get<OptionsResponse>('/api/options'));
  /** The demo passenger's details, so whoever is presenting has them on screen to read out. */
  protected readonly caller = computed(() => {
    const options = this.options();
    const scenario = options?.scenarios.find((s) => s.id === this.live.settings().scenario);
    return options && scenario ? { ...options.caller, line: scenario.callerLine } : null;
  });
  protected readonly draft = signal('');
  protected readonly phaseLabel = computed(() => PHASE_LABELS[this.live.phase()]);
  protected readonly bars = [0.45, 0.75, 1, 0.75, 0.45];
  /** Blends mic and speaker into one meter so the same bars show who is talking. */
  protected readonly level = computed(() => Math.min(1, Math.max(this.audio.micLevel() * 8, this.audio.outputLevel() * 6)));

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  constructor() {
    effect(() => {
      this.live.transcript();
      const element = this.scroller()?.nativeElement;
      if (element) queueMicrotask(() => (element.scrollTop = element.scrollHeight));
    });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.live.sendText(this.draft());
    this.draft.set('');
  }

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }
}
