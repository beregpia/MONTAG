# В какой программе делать: что позволяют API хостов

> Дата: 30 октября 2026. Вопрос: «мы работаем в Pro Tools / Cubase / Nuendo — можно
> написать софт **для них**, чтобы расставлять фоли внутри программы? Или другую
> DAW? Reaper?»
>
> Короткий ответ: **в Cubase и Nuendo — нельзя** (нет API аранжировки), **в Pro Tools —
> можно** (у Avid официальный Pro Tools Scripting SDK), **в Reaper — можно и бесплатно**,
> **в Resolve Studio — можно**. Подробности и три рабочих пути ниже.

---

## 1. Что умеет каждый хост (проверено по документации вендоров)

| Хост | Скриптовать аранжировку | Создавать/двигать клипы | Маркеры | Родное видео | Цена |
| --- | --- | --- | --- | --- | --- |
| **Pro Tools** | **да** — официальный [Pro Tools Scripting SDK](https://developer.avid.com/scripting/), «language-independent API», нужен Avid-аккаунт и принятие лицензии | да (через SDK) | да | есть | AAF/OMF импорт — только **Studio и выше** |
| **Nuendo** | **нет** | нет | **да** — импорт SMF-маркеров + импорт OMF/AAF (OMF умеет создавать маркеры на стыках видео) [1] | да | платная |
| **Cubase** | **нет** | нет | **да** — импорт SMF-маркеров + OMF/AAF (в свежих версиях) | да | платная |
| **Reaper** | **да, полностью** — ReaScript: Lua / Python / EEL2 / C [2] | **да** — `AddMediaItemToTrack`, `InsertMedia`, `SetMediaItemInfo_Value(D_POSITION/D_LENGTH)`, `format_timestr_pos` (таймкод) [2] | да | есть | $60 личная / $225 коммерческая |
| **DaVinci Resolve Studio** | **да** — Python (и Lua из консоли) | **да** — `AppendToTimeline({recordFrame: …})` = покадровая расстановка, `AddTrack`, `AddMarker(frameId,…)` [3] | да | **родное видео**, `GetCurrentClipThumbnailImage` | ~$295; **внешний скриптинг только в Studio** [4] |
| **Ableton Live + Max for Live** | да — Live API из Max | да (создание и перемещение клипов в аранжировке) | да | есть | Live + M4L |
| **Ardour** | да — Lua | да (создание и перемещение регионов) | да | есть | free / donation |

Важные уточнения:

- **VST3-плагины не могут трогать аранжировку нигде.** Плагин обрабатывает звук и
  рисует GUI — он не создаёт клипы на дорожках. Это ограничение SDK, а не конкретной DAW.
  Поэтому «написать софт для Cubase» в смысле «плагин, который сам расставит клипы» —
  невозможно; «софт, который проанализирует и выдаст файл для импорта» — возможно.
- **Pro Tools грузит только AAX-плагины** (свой SDK от Avid [5]); VST3 там не родной
  формат — нужны обёртки сторонних производителей. Так что «написал VST3 — работает
  везде» для Pro Tools неверно.
- **Cubase/Nuendo: MIDI Remote не управляет аудио-регионами** (мы это уже проверяли
  при работе над `.mid`-мостом), а VST3 — тем более. Единственный «внутри» путь для
  них — файловый обмен.

---

## 2. Но есть зрелый файловый путь — и он уже работает в индустрии

Пока не вся расстановка требует программирования: существуют инструменты, которые
превращают **список таймкодов** в маркеры/cue прямо в нужной DAW:

| Инструмент (Sounds In Sync) | Что делает | Для кого |
| --- | --- | --- |
| **EdiMarker** | создаёт маркеры в Pro Tools из **Excel / Text / WAV / XML / Ableton** — грузит таймкоды, футажи, mm:ss или сэмплы и делает маркеры в `.ptx` или `.MIDI` [6] | **Pro Tools** — наш детектор может сразу отдавать такой файл |
| **EdiChart** | делает фоли-cue-листы (PDF) из cue-сессии Pro Tools | печать для фоли-артиста |
| **EdiPrompt** | автоматизирует **запись фоли** в Pro Tools: переименовывает дорожки записи, наводится на каждую cue | студия записи |
| **EdiLoad** | **реконформит сессию при смене версий картины**, собирает location WAV для любой DAW | смена версий |
| **EdiCue** | ведёт cue-и в Pro Tools **и в Nuendo**, генерирует MIDI для EdiPrompt | ADR/фоли |

Отдельно про обмен целиком: **AAF/OMF** импортируют и Nuendo, и Cubase (в свежих
версиях), и Pro Tools (Studio+); при импорте OMF Nuendo умеет создавать маркеры на
началах видео-событий [1]. Nuendo additionally умеет **TTAL** (Netflix ADR).

И доказательство, что «нативная автоматизация в Pro Tools» реальна: **DX Assist**
подключается к живой сессии Pro Tools, применяет правки нативно (со undo в Pro Tools),
читает `.ptx` и AAF, делает ADR-cueing и импортирует cue-листы в форматах EdiCue PDF,
Netflix `.ttal` и `.srt` [7]; **fPost** (Forte AI) разбирает «грязные» AAF при импорте [8].

---

## 3. Три рабочих пути для вашего случая

### Путь 1. Движок анализа отдельно + три формата на выходе (рекомендую начать с этого)

Детекция визуальных событий не зависит от DAW — это Python/OpenCV/MediaPipe (или браузер,
как в MONTAG). Дальше результат отдаётся в трёх форматах, которые **ваши** DAW понимают
без всякого SDK:

1. **SMF с маркерами** → Cubase/Nuendo (`File → Import → MIDI File`, маркеры
   становятся маркерами проекта) — **это уже реализовано в MONTAG** (1 тик = 1 мс).
2. **XML/CSV с таймкодами и именами cue** → Pro Tools через **EdiMarker** (маркеры в `.ptx`).
3. **AAF/OMF с расставленными дублями** → импорт в PT Studio / Nuendo / Cubase: клипы
   встают на дорожки в точных таймкодах, и вы уже правите их внутри DAW.

Плюс: не зависит от хosta, работает со всеми тремя DAW, не требует партнёрства.
Минус: «внутрипрограммной» кнопки нет — импорт файла.

### Путь 2. Reaper как «станция споттинга»

Если готова ещё одна программа в цепочке — Reaper даёт **настоящий софт внутри хоста**:
ReaScript на Python/Lua создаёт дорожки, вставляет дубли в точные позиции
(`D_POSITION` — sample-точность), ставит маркеры и экспортирует AAF/OMF дальше в
PT/Nuendo/Cubase. Интерфейс — через **ReaImGui**, распространение — через **ReaPack**.
Python-скрипты в Reaper могут тащить OpenCV/MediaPipe, то есть анализ и расстановка
живут в одной программе.

Плюс: полная автоматизация внутри DAW, бесплатно, кроссплатформенно.
Минус: Reaper как четвёртый инструмент в pipeline.

### Путь 3. Нативный инструмент для Pro Tools (если PT — основной хост)

У Avid есть официальный **Pro Tools Scripting SDK** [5]: языконезависимый API,
скачивается после создания аккаунта и принятия лицензии. На таком SDK уже построены
продукты (DX Assist применяет правки в живой сессии PT [7]). Это даёт инструмент,
который работает прямо в Pro Tools как родной.

Плюс: никакого импорта файлов, всё в сессии.
Минус: только Pro Tools; для плагинной доставки в PT нужен AAX (партнёрская программа Avid).

### Бонус: Resolve Studio

Если Resolve где-то в цепочке есть — самый простой «внутри» путь: Python API умеет
`AppendToTimeline({mediaPoolItem, startFrame, endFrame, trackIndex, recordFrame,
mediaType})` — то есть **класть аудио на нужную дорожку в нужный кадр** — плюс
`AddMarker(frameId, …)`, `AddTrack`, родное видео и экспорт AAF/EDL/OTIO [3].
Ограничение: внешний скриптинг только в Studio (~$295), в бесплатной версии его нет [4].

---

## 4. Что я рекомендую

Учитывая, что основные хосты — PT / Nuendo / Cubase, и что в двух из них «внутри»
вообще ничего нельзя:

1. **Держать движок анализа отдельным** (Python или браузер) — он не привязан к DAW.
2. **Сделать экспорт cue-листа (CSV/XML с таймкодами + именами)** в MONTAG. Это
   закрывает Pro Tools через EdiMarker сразу и стоит 1–2 дня. Для Nuendo/Cubase
   уже есть `.mid`-мост.
3. **Добавить экспорт AAF/OMF** с расставленными дублями — тогда клипы физически
   попадают на дорожки в PT/Nuendo/Cubase, и дальше работа идёт привычными средствами.
4. **Если хочется «кнопки внутри программы»** — выбирать между ReaScript (Reaper)
   и Pro Tools Scripting SDK (PT). Reaper — бесплатно и проще; PT SDK — нативно,
   но только для PT.

Практически: пункты 1–3 дают рабочий процесс во всех трёх ваших DAW **без** необходимости
писать плагины или получать партнёрство у Avid. Пункт 4 — это уже про то, где вам удобнее
жить.

---

## 5. На что обратить внимание

- **Pro Tools Intro не импортирует AAF/OMF** — для файлового пути нужен минимум Studio.
- **VST3 ≠ Pro Tools.** Плагин для PT делается только на AAX; VST3-плагин туда не встанет
  без сторонней обёртки.
- **Resolve:** внешний Python-скриптинг и UIManager — только в Studio [4].
- **EdiMarker** берёт таймкоды/футажи/mm:ss/сэмплы — то есть формат выхода детектора
  должен быть одним из этих; сэмплы при 48 кГц дают максимум точности.
- При смене версий картины расстановку придётся пересчитывать — для PT это умеет EdiLoad,
  для остальных проще перегенерировать файл заново (и в этом смысле «отдельный движок +
  файл на выходе» выигрывает у любого «внутрихостового» решения).

---

## Источники

[1]: Steinberg Help — импорт/экспорт OMF и AAF в Nuendo (в т.ч. создание маркеров на стыках видео) — https://www.steinberg.help/r/nuendo/15.0/en/cubase_nuendo/topics/exchanging_files_with_other_applications/exchanging_files_with_other_applications_ttal_files_c.html
[2]: REAPER — ReaScript API (`AddMediaItemToTrack`, `InsertMedia`, `D_POSITION`, `format_timestr_pos`, `CreateNewMIDIItemInProj`) — https://www.reaper.fm/sdk/reascript/reascripthelp.html
[3]: DaVinci Resolve Studio — Python Scripting API Reference (`AppendToTimeline` с `recordFrame`, `AddMarker`, `AddTrack`, `ImportIntoTimeline`, экспорт AAF/EDL/OTIO/CSV) — https://gist.github.com/mhadifilms/2b84d469135315793220dbf2226cbe63
[4]: Resolve 21.1: внешний скриптинг и UIManager перенесены в Studio — https://xere.my/journal/davinci-resolve-21-1-free-python-scripting-removed-lua-benchmark/
[5]: Avid Developer — Audio: AAX SDK и **Pro Tools Scripting SDK** — https://developer.avid.com/audio/ ; страница SDK — https://developer.avid.com/scripting/
[6]: Sounds In Sync — EdiMarker / EdiChart / EdiPrompt / EdiLoad / EdiCue — https://www.soundsinsync.com/
[7]: DX Assist — подключение к живой сессии Pro Tools, правки нативно, `.ptx`/AAF, импорт cue в форматах EdiCue PDF / Netflix `.ttal` / `.srt` — https://www.production-expert.com/production-expert-1/dx-assist-automates-dialogue-editing-adr-cueing-and-alt-take-searches-in-pro-tools
[8]: Avid NAB 2026: fPost (Forte AI) — ИИ-разбор AAF при импорте в Pro Tools — https://www.production-expert.com/production-expert-1/avid-reveals-upcoming-pro-tools-features-at-nab-2026
