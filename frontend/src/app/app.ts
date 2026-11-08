import { Component, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { ControlPanel } from './ui/control-panel';
import { Conversation } from './ui/conversation';
import { Insights } from './ui/insights';
import { LiveSession } from './live/live-session.service';

@Component({
  selector: 'app-root',
  imports: [ControlPanel, Conversation, Insights],
  template: `
    <header class="top">
      <h1>Gemini Live control room</h1>
      <span class="pill">{{ live.settings().model }}</span>
      <span class="pill">{{ live.settings().mode === 'relay' ? 'Relay' : 'Direct token' }}</span>
      @if (health()?.hasApiKey === false) {
        <span class="pill bad">GEMINI_API_KEY is missing from .env</span>
      }
    </header>
    <main class="layout">
      <aside class="col left"><app-control-panel /></aside>
      <section class="col center"><app-conversation /></section>
      <aside class="col right"><app-insights /></aside>
    </main>
  `,
})
export class App {
  protected readonly live = inject(LiveSession);
  protected readonly health = toSignal(inject(HttpClient).get<{ hasApiKey: boolean }>('/api/health'));
}
