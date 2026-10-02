# Desktop compositing — 2026-10-02

Measured on the development Mac through the production daemon, authenticated Selkies relay and installed Chrome. XFWM compositing is on; `/general/vblank_mode` remains `off`.

| Scale | Input samples | Missing | Median | p95 | Maximum | Motion frames | Torn frames |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2× | 60 | 0 | 27 ms | 33 ms | 38 ms | 616 | 0 |
| 1× | 60 | 0 | 16 ms | 25 ms | 63 ms | 615 | 0 |

The motion page moved a vertical bar through every sampled row. All frames contained the bar; 581 of 616 frames at 2× and 569 of 615 at 1× moved it. None split its horizontal position between rows.

These latency samples use the S8 wall-clock input recorder, which includes the host-to-container command path. They are a compositor check, not the raw-XI2 ring-onset calibration. Raw records and screenshots are generated in the ignored `apps/web/e2e/out/` folder.

Reproduce with `LOCALDOT_COMPOSITOR=1 pnpm --filter @localdot/web exec playwright test e2e/compositor.spec.ts`.
