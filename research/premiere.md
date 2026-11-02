# Premiere Pro: что можно и чего нельзя

Исследование на ноябрь 2026. Нужно, чтобы понять, можно ли повторить в Premiere
то, что приложение делает в браузере, и через какой именно интерфейс.

Короткий ответ: **движок переносится целиком, а вот вывод — нет.** Всё, что
считается (детекция движения по картинке, индексация дорожек, сопоставление,
расстановка по кадрам), — это чистые вычисления над пикселями и сэмплами, им
всё равно, в каком окне они выполняются. Разница только в том, куда девать
результат.

---

## 1. Три способа говорить с Premiere — и какие из них годятся

| Способ | Состояние | Годится ли |
|---|---|---|
| **FCP7 XML (xmeml)** | Работает всегда, документирован Apple | ✅ **выбран** |
| **CEP-панель + ExtendScript** | Работает, но Adobe закрывает платформу | ⚠️ только для маркеров |
| **UXP-плагин** | GA в Premiere с ноября 2025 | ⭕ полный паритет, но это плагин |
| **Голый `.jsx`** | **В Premiere такого нет** | ❌ |
| **`.prproj`** | Проприетарный gzip-XML, меняется каждую версию | ❌ |
| **EDL** | Без многодорожечности и без маркеров | ❌ |

### Про голый `.jsx` — важное различие

В After Effects и Photoshop есть меню **File → Scripts**, и скрипт можно просто
положить в папку. **В Premiere Pro такого меню нет и никогда не было.** Ответ
сотрудника Adobe на прямой вопрос дословно:

> «CEP panels are the correct and supported approach to executing ExtendScript,
> within PPro. We have no plans to change that.»

То есть маркеры из скрипта в Premiere можно поставить только из панели. Для
нашего случая это лишний инсталлятор ради того, что XML делает без него.

### Сроки жизни CEP (объявление Adobe, сентябрь 2026)

- декабрь 2027 — Adobe Marketplace перестаёт принимать новые CEP-плагины для Premiere;
- декабрь 2028 — CEP выключен по умолчанию (пользователь сможет включить);
- декабрь 2029 — CEP исчезает из новых версий;
- **ExtendScript переходом не затрагивается.**

UXP в Premiere — уже GA, включая Hybrid-плагины с вызовами C++.

---

## 2. Что выбрано: FCP7 XML

Premiere открывает его через **File → Import**. Внутри — и клипы на звуковых
дорожках, и маркеры последовательности. Adobe подтверждает прямо:

> «PPro definitely *does* import sequence markers via FCP XML, and honors any
> valid XMP markers in source media referenced by the XML. PPro supports FCP7
> XML, as specified by Apple.»

Результат импорта — **новая последовательность** с фоли, разложенным по звуковым
дорожкам: строка на персонажа, клипы по кадрам, плюс маркеры. Это ровно та
картинка, которую приложение показывает на своем таймлайне.

Реализация: `js/premiere-export.js`, кнопка **「⇩ Premiere Pro (.xml)」** в
панели «Движок».

### Два места, которые ломаются молча

Оба найдены не догадкой, а сверкой с XML, который Premiere выгрузила сама.

**1. `pathurl`.** Стокое процент-кодирование пути ломает импорт **целиком** —
Premiere отвечает «проект повреждён и не может быть открыт», не упоминая пути.
Претендента на ошибку нет: структура валидна, файлы на диске. Четыре правила:

1. двоеточие диска кодируется: `C:` → `C%3a`;
2. hex-цифры **строчные**: `%3a`, не `%3A`;
3. `( ) [ ] & ~ ! $ ' * + , ; = @ _ - .` остаются как есть — `urllib.parse.quote`
   по умолчанию экранирует скобки, и `%28` в пути ровно этот случай и ломал;
4. пробел → `%20`, не-ASCII → процент-кодирование UTF-8.

Пример из выгрузки Premiere:
`file://localhost/C%3a/Users/me/Desktop/clips(OBS)[raw]/2025-09-30%2015-15-50.mp4`

**2. Частота кадра.** В FCP7 хранится **целый** timebase плюс флаг NTSC, поэтому
29.97 — это «30, но NTSC». Перепутать — ничего не упадёт, таймлайн просто
уедет: на 13 минутах расхождение ~0.8 с. Для 25 к/с (проект пользователя)
это `timebase 25`, `ntsc FALSE`, `displayformat NDF` — простой случай.

Ещё одно: **out-точка за концом файла — Premiere отклоняет весь импорт.**
Поэтому длительность каждой дорожки передаётся в XML, и out зажимается по ней.

### Ограничение, о котором надо знать

Браузер отдаёт только **имя** файла, не полный путь. Поэтому в панели есть поле
**«папка дорожек на диске»** — например `D:\Foley\Ep07`. Если его не заполнить,
клипы приедут офлайн, и Premiere один раз спросит, где файлы (по дорожке на
клик). Это единственное место, где без участия монтажёра не обойтись.

---

## 3. Если понадобится полный паритет — UXP

Чтобы размещение легло **в открытую последовательность** (а не в новую) и чтобы
его можно было отменить одним Ctrl+Z, нужен плагин. API (проверено на реальной
миграции CEP → UXP, апрель 2026):

```js
// дорожка меняется только внутри lockedAccess
await project.lockedAccess(async () => {
  const seq = premiere.SequenceEditor.getEditor(activeSequence);
  const action = seq.createInsertProjectItemAction(projectItem, time, videoTrackIndex, audioTrackIndex);
  await project.executeTransaction({ label: 'MONTAG фоли', actions: [action] });
});
```

Ключевые отличия от ExtendScript:

- `createInsertProjectItemAction()` / `createOverwriteItemAction()` — вставка и
  перезапись клипа на нужную дорожку и в нужное время;
- `project.executeTransaction()` — **все действия одной атомарной операцией**,
  один Ctrl+Z отменяет всё. В ExtendScript каждый клип отдельная операция;
- `premiere.FolderItem.cast(item)` — обход бинов (общий `ProjectItem` не умеет
  `getItems()`).

Обходной путь без плагина, если нужен только звук в проекте: экспорт CSV +
**EdiMarker** (маркеры в `.ptx`) или SMF-маркеры, которые приложение уже умеет
делать. Для Premiere SMF не подходит — он берёт маркеры из XML или из панели.

---

## 4. Что переносится в Premiere как есть

| Часть | Переносимость |
|---|---|
| Детекция движения по картинке (`js/vision.js`) | ✅ целиком |
| Индексация дорожек (`js/foley-library.js`) | ✅ целиком |
| Сопоставление и штраф за повторы (`js/foley-place.js`) | ✅ целиком |
| Привязка зон кадра к персонажам | ✅ целиком |
| Банк дорожек и вырезка дублей (`js/audio-bank.js`) | ✅ целиком |
| Слой размещения (`state.placements`) | ✅ как модель |
| Вывод: клипы на таймлайне | ⭕ через UXP, либо через FCP7 XML |
| Вывод: маркеры | ✅ через FCP7 XML |

Важно: **CEP-панель — это и есть браузер.** Внутри неё работает Chromium и
Node.js, поэтому весь наш код (модули, canvas, Web Audio) переносится в панель
без переписывания. UXP-плагин устроен иначе — там свой рантайм и свои ограничения
по API, но WebView-слой там тоже есть.

---

## Источники

- Premiere Pro Scripting Guide (ExtendScript API) — https://ppro-scripting.docsforadobe.dev/
- Adobe: «Investing in the Future of Creative Cloud Extensibility» (сентябрь 2026) — https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications
- Adobe forums: миграция Node + Puppeteer с CEP на UXP, timeline injection — https://forums.creativeclouddeveloper.com/t/migrating-a-local-node-js-puppeteer-workflow-from-cep-to-uxp-premiere-pro-need-architectural-guidance/11886
- Adobe: «Importing XML files from Final Cut Pro 7 and Final Cut Pro X» — https://helpx.adobe.com/africa/premiere-pro/using/importing-xml-project-files-final.html
- Adobe staff: «PPro definitely does import sequence markers via FCP XML» — https://community.adobe.com/t5/premiere-pro-discussions/import-markers/td-p/13109479
- Adobe staff: «CEP panels are the correct and supported approach to executing ExtendScript, within PPro» — https://community.adobe.com/t5/premiere-pro-discussions/is-there-a-way-to-launch-one-time-use-jsx-script-files-like-you-can-in-after-effects/td-p/14028473
- FCPCafe, «Demystifying Final Cut Pro XMLs» — структура `<marker>`, `<in>/<out>` в кадрах — https://fcp.cafe/developer-case-studies/fcpxml/
- `premiere-xml` — референсный генератор FCP7 XML, проверен на Premiere 25.x/26.x Windows — https://github.com/boyjustin76/premiere-xml
