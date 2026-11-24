# lever

어느 MCP 클라이언트에서나 쓰는 Code Mode 입니다. 모델이 JavaScript 한 덩어리를 쓰면 lever 가 셸·파일·검색·MCP 도우미 함수와 함께 실행하고, 코드가 돌려준 값만 모델에게 보냅니다.

Claude Code 2.1.330(`claude -p`, 백그라운드 세션)과 Codex(`codex exec`)에서 시험했습니다. stdio 로 MCP 서버를 띄우는 다른 클라이언트도 같은 규약을 쓰지만 아직 시험하지 않았습니다. 다른 패키지에 기대지 않으며 Node 20.11 이상이 필요합니다.

[English README](README.md)

## 왜 필요한가

에이전트가 쓰는 토큰의 대부분은 한 번 읽고 버리는 도구 출력입니다. 한 줄을 찾으려고 파일 전체를 읽고, 실패 하나를 찾으려고 테스트 기록 전체를 읽고, 이름마다 검색을 한 번씩 합니다. 단계마다 모델이 한 번 더 답해야 하는 것도 비용입니다. lever 를 쓰면 모델이 단계를 코드로 씁니다. 반복·거르기·세기는 Node 가 하고, 모델은 답만 읽습니다.

아래는 측정 중 실제로 나온 호출입니다. Claude Haiku 에게 가장 긴 소스 파일 세 개를 물었더니 `run` 을 한 번 불렀습니다.

```js
const files = await glob('src/**/*.mjs');
const counts = [];
for (const f of files) {
  const text = await read(f);
  counts.push({ f, n: text.split('\n').length });
}
counts.sort((a, b) => b.n - a.n);
return counts.slice(0, 3).map(c => `${c.f}: ${c.n}`).join('\n');
```

lever 는 파일 15개(126.6 KB)를 읽고 73바이트를 돌려보냈습니다.

```
src/helpers/mcp.mjs: 390
src/helpers/search.mjs: 361
src/session.mjs: 318
---
1 glob, 15 read · read 126.6 KB, returned 73 B · 180 ms
```

## 측정

### 실제 Claude Code 에서

`npm run stress` 는 파일 82개짜리 프로젝트를 만들어 놓고 Claude Code 에 여러 단계가 필요한 과제 11개를 줍니다. 테스트가 통과할 때까지 버그 고치기, 함수를 옮기고 import 전부 고치기, 함수 시그니처와 호출부 전부 바꾸기, 테스트를 깨뜨린 커밋 찾기, 파일 15개를 차례로 따라가기 같은 일입니다. 과제마다 세 방식으로 돌립니다. 기본 도구(Glob, Grep, Read, Edit, Write, Bash)만 쓰는 방식, 기본 도구와 lever 를 함께 두는 방식(보통 설치), lever 의 `run` 만 쓰는 방식입니다. 실행마다 프로젝트의 새 사본에서 일하고, 결과가 맞는지는 채점기가 판정합니다. 각 줄은 3회의 중앙값입니다.

모델 호출은 모델과 한 번 주고받는 것을 말합니다. Claude Code 가 내놓는 턴 수는 도구 호출 수에 1을 더한 값이라, 기본 도구가 한 번에 여러 호출을 보내는 것이 드러나지 않습니다. 그래서 여기서는 쓰지 않습니다. 이 측정은 2026-11-24 에 Claude Code 2.1.330 으로 했고, 사용자의 설정과 hook 은 뺐습니다.

Claude Haiku, 99회, 결과 모두 정답:

| 과제 11개 합계 | 정답 | 모델 호출 | 도구 호출 | 입력 토큰 | 출력 토큰 | 비용(USD) | 시간(초) |
| :- | :-: | -: | -: | -: | -: | -: | -: |
| 기본 도구만 | 33/33 | 56 | 74 | 1,328,725 | 20,811 | 0.0508 | 113.0 |
| 기본 도구 + lever | 33/33 | 37 (−34%) | 28 (−62%) | 904,163 (−32%) | 12,802 (−38%) | 0.0391 (−23%) | 73.7 (−35%) |
| lever 만 | 33/33 | 33 (−41%) | 22 (−70%) | 657,964 (−50%) | 11,523 (−45%) | 0.0354 (−30%) | 67.4 (−40%) |

Claude Opus, 99회, 결과 모두 정답:

| 과제 11개 합계 | 정답 | 모델 호출 | 도구 호출 | 입력 토큰 | 출력 토큰 | 비용(USD) | 시간(초) |
| :- | :-: | -: | -: | -: | -: | -: | -: |
| 기본 도구만 | 33/33 | 41 | 30 | 896,447 | 8,624 | 1.2452 | 105.8 |
| 기본 도구 + lever | 33/33 | 35 (−15%) | 24 (−20%) | 801,265 (−11%) | 6,983 (−19%) | 1.1271 (−9%) | 86.8 (−18%) |
| lever 만 | 33/33 | 35 (−15%) | 24 (−20%) | 648,274 (−28%) | 7,412 (−14%) | 1.0981 (−12%) | 87.3 (−17%) |

과제별(Haiku). 기본 도구만 → 기본 도구 + lever → lever 만 순서입니다.

| 과제 | 모델 호출 | 입력 토큰 | 시간(초) | lever 선택 |
| :- | :-: | :-: | :-: | :-: |
| 버그 3개를 고쳐 테스트 통과시키기 | 4 → 4 → 4 | 100k → 106k → 88k | 9 → 8 → 7 | 3/3 |
| 함수를 새 모듈로 옮기고 import 전부 고치기 | 5 → 4 → 3 | 123k → 99k → 60k | 15 → 9 → 9 | 3/3 |
| 아무 데서도 안 쓰는 export 찾기 | 4 → 2 → 2 | 106k → 45k → 36k | 14 → 5 → 5 | 3/3 |
| 4 MB 로그에서 오류 통계 내기 | 4 → 3 → 2 | 87k → 69k → 36k | 7 → 5 → 4 | 3/3 |
| 함수와 테스트 추가 | 4 → 3 → 3 | 91k → 71k → 57k | 7 → 6 → 6 | 3/3 |
| 설정 파일 값을 모듈 15개에 반영 | 4 → 4 → 4 | 95k → 103k → 86k | 7 → 6 → 6 | 3/3 |
| 한 모듈에 기대는 파일 전부 찾기 | 3 → 2 → 2 | 70k → 45k → 36k | 12 → 7 → 6 | 3/3 |
| 660줄 모듈의 버그 2개 고치기 | 4 → 5 → 5 | 116k → 129k → 107k | 8 → 9 → 8 | 2/3 |
| 함수 시그니처와 호출부 전부 바꾸기 | 4 → 4 → 3 | 96k → 95k → 59k | 11 → 7 → 6 | 3/3 |
| 테스트를 깨뜨린 커밋 찾기 | 4 → 4 → 3 | 90k → 96k → 57k | 8 → 10 → 9 | 0/3 |
| 설정 파일 15개를 차례로 따라가기 | 16 → 2 → 2 | 355k → 45k → 36k | 14 → 3 → 3 | 3/3 |

숫자가 말하는 것:

- 이득은 과제의 모양에 따라 다릅니다. 앞 단계의 결과가 다음 단계를 정하는 일(파일 사슬, 여러 파일에 걸친 분석, 로그)에서는 실행 한 번이 여러 번의 모델 호출을 대신합니다. 사슬 과제는 16 → 2번이었습니다. "읽고, 고치고, 테스트하는" 일에서는 기본 도구도 한 번에 여러 호출을 보냅니다. 그런 일에서 lever 는 모델 호출 수가 같고, 도구 호출·출력 토큰·시간을 조금 줄입니다.
- 이득은 모델에 따라 다릅니다. Opus 는 기본 도구 호출을 잘 묶고 셸 반복문도 스스로 씁니다. 그래서 보통 설치의 절감이 모델 호출 15%, 시간 18%입니다. Haiku 는 34%, 35%입니다.
- Haiku 합계의 큰 몫이 과제 하나에서 나옵니다. 사슬 과제를 빼면 보통 설치의 절감은 모델 호출 12%, 입력 토큰 12%입니다.
- lever 가 모든 과제에서 낫지는 않습니다. 660줄 모듈 과제에서는 두 모델 모두 lever 쪽이 모델 호출을 한 번 더 썼습니다. 답 한 번에 8,000자까지 담기므로 큰 파일 전체가 한 번에 돌아오지 않습니다.
- "lever 만" 방식은 기본 도구 6개의 설명도 빠져서 모델 호출마다 약 3,300 토큰이 더 줄어듭니다. Claude Code 를 이 방식으로 쓰려면 `claude --disallowedTools Bash Read Edit Write Glob Grep` 으로 시작합니다. `claude --tools ""` 로 시작하면 기본 도구가 모두 빠지고 lever 만 남습니다. 그때의 변화는 다음 측정에 있습니다.
- 보통 설치에서는 모델이 도구를 고릅니다. Haiku 는 33회 중 29회, Opus 는 33회 중 33회 lever 를 골랐습니다. 이 선택은 lever 안내문의 표현이 가릅니다. 안내문에 반복과 "앞 단계에서 이어지는 단계"를 적기 전에는 Haiku 가 9회 중 5회에서 사슬 파일 15개를 하나씩 읽었습니다.
- 줄마다 3회는 작은 표본이고, 같은 줄도 돌릴 때마다 모델 호출이 한 번씩 달라집니다. 같은 기록에서 무작위로 다시 뽑아 계산하면 Haiku 보통 설치의 모델 호출 절감은 29~38% 범위입니다. 이 숫자에 기대기 전에 쓰는 모델과 프로젝트로 직접 돌려 보세요.

전체 표, 이번 수정 전의 결과, 모델이 쓴 코드에서 드러난 문제, 답 길이 한도 세 가지 비교는 [bench/results/2026-11-24.md](bench/results/2026-11-24.md) 에 있습니다(영문).

### Claude Code 의 Code Mode 와 나란히

Claude Code 에는 실험 기능인 자체 Code Mode 가 있습니다. 터미널에서 직접 연 대화형 세션에서만 켜지므로, `bench/stress/terminal.mjs` 가 같은 과제 11개를 tmux 로 띄운 대화형 세션에서 돌리고 세션 기록에서 숫자를 읽습니다. 모든 방식을 같은 종류의 세션에서 돌렸으므로 아래 줄은 모두 같은 조건입니다. Claude Haiku, 2026-11-24 의 Claude Code 2.1.331, 줄마다 3회, 세션 198개입니다.

| 과제 11개의 합 | 정답 | 모델 호출 | 입력 토큰 | 출력 토큰 | 비용(USD) | 시간(초) |
| :- | :-: | -: | -: | -: | -: | -: |
| 기본 도구만 | 33/33 | 59 | 2,236,725 | 18,925 | 0.0570 | 134.3 |
| Code Mode | 31/33 | 39 (−34%) | 995,811 (−55%) | 15,713 (−17%) | 0.0437 (−23%) | 106.5 (−21%) |
| 기본 도구 + lever | 33/33 | 38 (−36%) | 1,480,664 (−34%) | 12,825 (−32%) | 0.0447 (−22%) | 92.8 (−31%) |
| lever 만 | 33/33 | 37 (−37%) | 1,321,263 (−41%) | 13,030 (−31%) | 0.0433 (−24%) | 91.4 (−32%) |
| lever, 기본 도구 없음 | 32/33 | 39 (−34%) | 316,549 (−86%) | 12,778 (−32%) | 0.0209 (−63%) | 84.3 (−37%) |
| Code Mode + lever | 31/33 | 35 (−41%) | 924,652 (−59%) | 16,019 (−15%) | 0.0445 (−22%) | 105.5 (−21%) |

숫자가 보여 주는 것:

- **모델 호출 수와 비용은 같습니다.** Code Mode 는 모델 호출 39번, lever 보통 설치는 38번, lever 만 쓰는 방식은 37번이었습니다. 줄마다 3회로는 가를 수 없는 차이이고, 비용 차이도 3% 안입니다.
- **입력 토큰은 Code Mode 가 lever 보통 설치보다 적습니다. 도구 설명 때문입니다.** 모델 호출 한 번은 기본 도구가 있는 세션에서 35,472 토큰, lever 를 더하면 36,553 토큰, Code Mode 에서는 22,369 토큰에서 시작합니다. Code Mode 는 도구 설명 전체를 설명 하나로 바꿉니다. 그래서 lever 보통 설치가 Code Mode 보다 입력 토큰을 49% 더 읽었습니다. 그 대부분은 값이 싼 프롬프트 캐시에서 읽으므로 비용은 같습니다.
- **기본 도구를 모두 뺀 lever 가 가장 적게 읽습니다.** `claude --tools ""` 로 시작하면 lever 가 유일한 도구가 되고, 모델 호출 한 번이 5,779 토큰에서 시작합니다. 과제 11개의 입력 토큰이 Code Mode 보다 68% 적었고 비용은 절반쯤이었습니다. 대신 그 세션에는 하위 에이전트, 스킬, 웹 도구가 없습니다. Haiku 가 쓴 코드도 더 자주 실패했습니다. lever 실행 87번 중 12번이었고, 다른 도구 설명이 있을 때는 80번 중 2번이었습니다.
- **lever 가 더 빨랐고 답이 맞았습니다.** 보통 설치는 92.8초, Code Mode 는 106.5초였습니다. Code Mode 는 답 33개 중 2개가 틀렸습니다. 둘 다 4MB 로그 과제였습니다. 셸 결과에 로그 42,000줄 중 13,015줄만 담겼는데 알림이 없어서, 그 부분만 센 값이 답이 됐습니다.
- **Code Mode 의 코드는 83개 중 한 번도 실패하지 않았습니다.** lever 의 코드는 보통 설치에서 58번 중 4번 실패했습니다.
- **둘을 같이 켜도 얻는 것이 없습니다.** Code Mode 를 켜고 lever 를 연결한 세션 33개에서 모델은 lever 를 한 번도 쓰지 않았습니다.
- Haiku 만 잰 결과입니다. Code Mode 는 실험 기능이라 판마다 바뀔 수 있습니다.

정리하면, 둘 다 켤 수 있는 터미널 세션에서는 모델 호출 한 번이 하는 일이 비슷합니다. Code Mode 가 켜지지 않는 곳(`claude -p`, 백그라운드 세션, Codex 같은 다른 클라이언트)에서는 lever 가 그 일을 합니다. 방법, 과제별 표, 양쪽 코드에서 드러난 것은 [bench/results/2026-11-24-code-mode.md](bench/results/2026-11-24-code-mode.md) 에 있습니다(영문).

### 모델 없이

`npm run bench` 는 이 저장소의 사본 위에서 짧은 일 네 가지를 모델 없이 두 방식으로 해 봅니다. 기본 도구 쪽은 단계마다 호출을 한 번씩 하고 Claude Code 도구가 돌려주는 출력(줄 번호가 붙은 Read, 절대 경로)의 글자 수를 셉니다. lever 쪽은 `run` 을 한 번 부르고 그 답의 글자 수를 셉니다. 토큰은 글자 수 ÷ 4 로 어림했습니다.

| 할 일 | 도구 호출 | 모델이 읽는 글자 | ≈ 토큰 | 줄어든 비율 |
| :- | :-: | -: | -: | -: |
| 가장 긴 소스 파일 세 개 | 16 → 1 | 184,831 → 129 | 46,208 → 32 | 99.9% |
| format.mjs 가 내보내는 이름마다 쓰는 파일 수 | 15 → 1 | 16,555 → 229 | 4,139 → 57 | 98.6% |
| 함수 이름 전부 바꾸기 | 5 → 1 | 34,525 → 158 | 8,631 → 40 | 99.5% |
| 테스트 돌리고 실패만 보고 | 1 → 1 | 6,798 → 416 | 1,700 → 104 | 93.9% |
| **네 가지 합계** | **37 → 4** | **242,709 → 932** | **60,677 → 233** | **99.6%** |

이름 바꾸기는 두 방식 모두 같은 파일을 남겼습니다. 기본 도구 쪽이 단계마다 호출을 한 번씩 하는 방식이라, 이 표는 lever 가 줄일 수 있는 최대치입니다. 실제 모델은 기본 도구로도 더 짧은 길을 자주 찾습니다(한 번에 여러 호출을 보내거나, 셸 명령 하나로 일을 끝냅니다). 그래서 위의 실제 Claude Code 측정에서는 줄어든 폭이 더 작습니다.

## 설치

```sh
npm install -g lever-code
lever install    # PATH 에 있는 Claude Code 와 Codex 에 lever 를 등록
lever doctor     # 설정을 점검하고 시험 실행을 한 번 함
```

- `lever install --claude` 나 `lever install --codex` 로 한쪽만 등록합니다. `--scope project` 는 지금 프로젝트에만 등록합니다(Claude Code).
- 다른 MCP 클라이언트에는 명령이 `lever`(인자 없음)인 stdio 서버를 추가하면 됩니다.
- 소스에서 설치: `git clone https://github.com/Junhan2/lever && cd lever && node bin/lever.mjs install`
- 지우기: `lever uninstall`

설치한 뒤 새 세션을 여세요. Claude Code 에서는 `/mcp` 목록에 `lever` 가 보입니다.

## 모델이 받는 도구

도구는 `run` 하나입니다.

| 입력 | 뜻 |
| :- | :- |
| `code` | JavaScript. 맨 바깥에서 `await` 를 쓸 수 있습니다. 마지막 식이나 맨 바깥의 `return` 이 결과입니다. |
| `background` | `true` 면 작업으로 시작하고 바로 답합니다. |
| `timeout` | 실행을 멈출 때까지의 초(기본 600, 백그라운드 작업은 7200). |

도구 설명은 약 1.6 KB 입니다. Claude Code 는 이 도구를 처음부터 올려 두므로(`anthropic/alwaysLoad`) 첫 호출 전에 도구 검색을 하지 않습니다. 모델에게 드물게 필요한 내용은 `help(주제)` 뒤에 있습니다.

### 코드 안에서 쓰는 함수

경로는 프로젝트 폴더 기준이고, 명령도 그 폴더에서 실행됩니다. 함수는 모두 비동기입니다.

| 함수 | 하는 일 |
| :- | :- |
| `` await $`cmd ${x}` `` | 셸 명령을 실행합니다. 끼워 넣은 값은 따옴표로 감쌉니다. 종료 코드가 0이 아니면 오류를 냅니다. 결과는 `{stdout, stderr, exitCode, ok}` 입니다. 명령이 시작되기 전에 `.nothrow()`, `.cwd(dir)`, `.env({...})`, `.timeout(ms)`, `.input(text)` 를 이어 붙이고, 그 뒤에 `.text()`, `.lines()`, `.json()` 을 붙입니다. 같은 설정을 옵션으로도 줄 수 있습니다: `` $({cwd, env, timeout, input})`...` ``. |
| `await read(path, {from, to})` | 파일이나 그 일부 줄을 읽습니다. |
| `await write(path, 글이나 객체)` | 파일을 쓰고 폴더도 만듭니다. 객체는 JSON 으로 씁니다. |
| `await edit(path, old, new, {all})` | 글을 바꿉니다. `all` 이 없으면 찾는 글이 정확히 한 번 있어야 하고, 아니면 줄 번호나 힌트와 함께 오류를 냅니다. 모든 줄이 파일보다 더 또는 덜 들여쓰여 들어온 글도 찾아서 바꾸고, 그랬다고 답에 적습니다. 같은 파일을 한꺼번에 고쳐도 차례대로 실행되어 모두 반영됩니다. `edit(path, [[old, new], ...])`, `edit(path, text => newText)` 도 됩니다. |
| `await exists(path)`, `await ls(dir)` | 경로가 있는지 보고, 폴더를 나열합니다. `await` 없는 `exists` 는 promise 라서 조건에서 항상 참이 됩니다. 그런 호출은 답에서 알려 줍니다. |
| `await glob('src/**/*.ts')` | 파일 목록을 정렬해 돌려줍니다. 숨김 이름, `node_modules`, `.gitignore` 에 적힌 것은 건너뜁니다. ripgrep 이 있든 없든 같습니다. |
| `await grep(/re/i 또는 'text', {path, glob, context, files, count, max})` | ripgrep 으로(없으면 Node 로) 찾습니다. `[{file, line, text}]` 를 돌려주고 `file:line:text` 줄로 찍습니다. `{files: true}` 는 경로를, `{count: true}` 는 개수를 돌려줍니다. JavaScript 만 아는 패턴(lookbehind, 역참조)은 같은 파일들을 Node 로 찾습니다. 정규식이 아닌 문자열은 글자 그대로 찾습니다. |
| `undo()` | 가장 최근에 파일을 바꾼 실행이 쓴 파일들을 되돌립니다. |
| `state` | 실행 사이에 유지되는 객체입니다. 변수는 유지되지 않습니다. 실행마다 범위가 따로입니다. |
| `jobs.list()`, `jobs.wait(id)`, `jobs.cancel(id)` | 백그라운드 작업. |
| `mcp.<서버>.<도구>(args)` | 코드 안에서 다른 MCP 서버를 부릅니다. Claude Code 설정, `.mcp.json`, lever 설정에 있는 stdio 서버가 대상입니다. `mcp.servers()`, `mcp.tools(이름)` 로 목록을 봅니다. |
| `help(주제)` | `shell`, `files`, `search`, `mcp`, `jobs`, `output` 의 자세한 설명. |

Node 의 모듈(`import`, `require`)도 쓸 수 있지만 lever 의 검사를 거치지 않습니다. [안전](#안전)을 보세요.

### 답의 모양

1. 코드가 찍은 로그, 그다음 결과. 문자열은 그대로 찍습니다. 객체는 한 줄짜리 값을 `key: value` 줄로 먼저 찍고, 여러 줄짜리 값은 `==> key <==` 줄 아래에 원문 그대로 찍습니다. 이렇게 돌아온 파일 글은 `edit` 에 그대로 넣을 수 있습니다. 객체 배열은 한 줄에 JSON 하나씩 찍습니다.
2. `---` 아래 요약: 종류별 단계 수, 읽은 바이트와 돌려준 바이트, 걸린 시간, 실패하거나 거절된 단계, 바뀐 파일(`undo()` 로 되돌릴 수 있다는 안내 포함), hook 이 남긴 메시지, 그리고 `await` 없이 부른 함수 같은 실수 안내.
3. 답이 8,000자를 넘게 되면 가장 긴 문자열부터 가운데를 자르고, 그래도 넘치면 긴 목록을 줄입니다. 필요한 만큼만 줄입니다. 전체 글은 본인만 읽을 수 있는 파일에 저장하고 그 경로를 답에 적습니다. 저장하는 글은 최대 16 MB 이고, 일주일이 지난 것은 서버가 시작할 때 지웁니다.
4. 오류가 나면 코드의 몇째 줄에서 났는지 알려 줍니다. 흔한 실수에는 고치는 법도 붙입니다: `(` 로 시작하는 줄 앞의 빠진 세미콜론, 함수와 같은 이름의 변수, 이전 실행에서 선언한 이름, `$` 에 없는 메서드. 없는 파일을 읽으면 그 폴더의 비슷한 이름을 알려 줍니다.

### 오래 걸리는 실행

실행은 10분, 백그라운드 작업은 2시간이 지나면 멈춥니다. Codex 는 MCP 도구를 60초까지만 기다리므로, Claude Code 가 아닌 클라이언트에서는 50초가 지나면 lever 가 먼저 답하고 실행을 작업으로 이어 갑니다. 모델은 `jobs.wait(id)` 로 결과를 받습니다. 끝없는 반복처럼 실행이 제어를 돌려주지 않으면 lever 는 그 실행 스레드를 새것으로 바꾸고, 실행이 띄운 프로세스를 끝내고, `state` 를 비운 채 다시 시작합니다. 코드가 남기고 간 오류(나중에 오류를 내는 타이머, 아무도 기다리지 않는 실패한 promise)로는 스레드가 끝나지 않습니다. 다음 답에 안내로 나옵니다.

## 안전

lever 는 코드 안의 모든 단계를 그 단계에 해당하는 Claude Code 도구 이름(`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `mcp__서버__도구`)으로 검사합니다.

1. **가드 모듈**: 직접 지정한 검사 파일입니다. [가드 모듈](#가드-모듈)을 보세요.
2. **Claude Code 의 권한 규칙**: 설정 파일의 `deny` 규칙은 그 단계를 거절합니다. `ask` 규칙도 거절하되, 그 호출은 평소 도구로 하라는 메시지를 모델에게 줍니다. 그러면 평소처럼 확인 창이 뜹니다. lever 가 직접 확인 창을 띄울 수는 없습니다.
3. **Claude Code 의 hook**: 도구 호출 앞뒤에 도는 `PreToolUse`·`PostToolUse` 명령을 문서에 적힌 입력, 종료 코드, JSON 필드 그대로 실행합니다.

2와 3은 lever 가 Claude Code 아래에서 돌 때 켜집니다. 다른 클라이언트(예: Codex)에서도 쓰려면 `LEVER_HOOKS=on`, 끄려면 `LEVER_HOOKS=off` 로 둡니다. `glob`, `grep`, `ls` 는 `Read` deny 규칙에 걸리는 파일을 목록에서 뺍니다.

**lever 는 격리 실행 환경(sandbox)이 아닙니다.** 코드는 사용자 권한으로 Node 작업 스레드에서 돕니다. 코드가 `import('node:fs')` 나 `require('node:child_process')` 를 쓰면 위 검사를 모두 건너뛸 수 있습니다. 검사는 평범한 함수 호출을 잡을 뿐, 검사를 피하려고 쓴 코드는 막지 못합니다. Bash 규칙이 명령 글자를 맞춰 보는 것도 Claude Code 와 같습니다. 에이전트의 Bash 도구를 믿는 만큼만 lever 를 믿고, 격리가 필요하면 클라이언트를 컨테이너나 가상 머신 안에서 돌리세요. Claude Code 에 들어 있는 Code Mode 도 같은 한계가 있습니다. 공식 문서에 따르면 JavaScript 자체와 그 안의 파일·MCP 호출은 sandbox 밖에서 돕니다.

### 가드 모듈

가드 모듈은 함수 하나를 내보냅니다. lever 는 단계마다 그 함수를 먼저 부릅니다.

```js
export default function ({ tool, input, cwd }) {
  // 거절하려면 이유(문자열)를, 모델에게 말을 전하려면 { note } 를, 통과시키려면 null 을 돌려줍니다.
}
```

[examples/guards/deny-paths.mjs](examples/guards/deny-paths.mjs) 는 `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `.env` 파일에 닿는 단계를 거절합니다. `LEVER_GUARDS=/경로/a.mjs:/경로/b.mjs` 나 설정 파일의 `guards` 목록으로 불러옵니다.

## Claude Code 에 들어 있는 Code Mode 와 비교

Claude Code 는 v2.1.323(2026년 11월)에서 실험 기능 Code Mode 를 넣었습니다. 왼쪽 칸은 2026-11-21 에 읽은 [공식 문서](https://code.claude.com/docs/en/code-mode) 내용입니다. 같은 터미널 세션에서 둘을 나란히 잰 결과는 [측정](#claude-code-의-code-mode-와-나란히)에 있습니다.

| | 기본 Code Mode | lever |
| :- | :- | :- |
| 쓸 수 있는 곳 | 터미널에서 직접 연 대화형 세션만. `-p`, Agent SDK, VS Code, 데스크톱 앱, 클라우드 세션, 백그라운드 세션에서는 안 됨 | Claude Code 의 모든 세션 종류, Codex, 다른 MCP 클라이언트 |
| 모델과 계정 | Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2. Anthropic API 직결만(Bedrock, Vertex, 게이트웨이, API 키 도우미 불가) | 클라이언트가 쓰는 그대로 |
| 꺼지는 기능 | Remote Control, Claude in Chrome, computer use, 일부 플러그인과 mod, OpenTelemetry 내보내기 | 없음. 평소 도구 옆에 도구 하나가 더 생길 뿐 |
| 세션 이어 하기 | Code Mode 세션은 Code Mode 를 켠 상태로만 이어 할 수 있음 | 세션에 영향 없음 |
| 호출마다 하는 검사 | `deny`·`ask` 규칙, `PreToolUse` hook, 확인 창 | `deny` 규칙, `ask` 규칙(메시지와 함께 거절), `PreToolUse`·`PostToolUse` hook, 가드 모듈. 확인 창 없음 |
| 셸 격리 | 셸 명령은 Claude Code 의 sandbox 설정을 따름 | 적용 안 함 |
| 화면에 보이는 것 | 편집 변경 내역 같은 도구 호출 하나하나. 코드는 대화 기록 보기 화면에 | 코드와 답이 담긴 호출 하나 |
| 오래 걸리는 실행 | 10분. auto·bypass 모드에서는 백그라운드로 최대 2시간 | 10분. 백그라운드 작업 최대 2시간. 도구 제한 시간이 짧은 클라이언트에는 먼저 답함 |
| 큰 출력 | `REPL` 에 거는 `PostToolUse` hook 으로 바꿀 수 있음 | 8,000자 안으로 줄이고 전체는 파일로, 요약 줄 포함 |
| 코드에서 부르는 MCP 서버 | Claude Code 의 연결을 그대로 씀 | stdio 서버마다 lever 가 따로 띄움. HTTP 서버는 못 부름 |

## 한계

- 격리 실행 환경이 아닙니다. [안전](#안전)을 보세요.
- 확인 창이 없습니다. `ask` 규칙에 걸리면 그 단계는 거절됩니다.
- `mcp.<서버>` 는 stdio 서버를 따로 하나 더 띄웁니다. 클라이언트의 연결, 로그인, 상태를 같이 쓰지 않고, HTTP 서버에는 닿지 못합니다.
- Claude Code 화면에는 단계마다가 아니라 실행마다 도구 호출이 하나씩 보입니다.
- 프로젝트 파일을 `import()` 하면 처음 읽은 사본이 계속 쓰입니다. 그 뒤에 파일이 바뀌었으면 답에 안내가 나옵니다. 새 코드를 돌리려면 프로세스를 띄웁니다(`` $`node file.mjs` ``).
- ripgrep 이 없을 때 `.gitignore` 는 흔히 쓰는 문법만 따릅니다(주석, `!`, 위치가 고정된 패턴, 폴더 전용 패턴). `.git/info/exclude` 와 전역 ignore 파일은 읽지 않습니다.

## 설정

환경 변수가 먼저이고, 그다음 `~/.config/lever/config.json`(또는 `LEVER_CONFIG` 가 가리키는 파일), 마지막이 기본값입니다.

| 환경 변수 | 설정 키 | 기본값 | 뜻 |
| :- | :- | :- | :- |
| `LEVER_MAX_OUTPUT` | `maxOutput` | `8000` | 답 하나에 담는 최대 글자 수. 넘으면 나머지는 파일로 |
| `LEVER_TIMEOUT_MS` | `timeoutMs` | `600000` | 실행 제한 시간 |
| `LEVER_BACKGROUND_TIMEOUT_MS` | `backgroundTimeoutMs` | `7200000` | 백그라운드 작업 제한 시간 |
| `LEVER_AUTO_BACKGROUND_MS` | `autoBackgroundMs` | Claude Code 는 `0`(끔), 다른 클라이언트는 `50000` | 아직 도는 실행을 작업으로 넘기는 시점 |
| `LEVER_HOOKS` | `hooks` | `auto` | 권한 규칙과 hook: `on`, `off`, `auto`(Claude Code 아래서 켜짐) |
| `LEVER_GUARDS` | `guards` | 없음 | 가드 모듈, `:` 로 구분 |
| `LEVER_SHELL` | `shell` | `bash`, 없으면 `sh` | `$` 가 쓰는 셸 |
| `LEVER_SPILL_DIR` | `spillDir` | `<tmp>/lever-<uid>` | 긴 답을 저장하는 곳 |
| `LEVER_MCP_IMPORT` | `mcpImport` | `claude:project` | `mcp` 에 넣을 서버 목록: `claude`(Claude Code 설정), `project`(`.mcp.json`) |
| | `mcpServers` | 없음 | 더 쓸 MCP 서버, `.mcp.json` 형식 |
| `LEVER_RG` | | `PATH` 의 ripgrep | 쓸 ripgrep 경로, 또는 `off` |

프로젝트 폴더는 클라이언트가 `CLAUDE_PROJECT_DIR` 를 주면 그것이고, 아니면 클라이언트가 lever 를 띄운 폴더입니다.

## 명령

| 명령 | 하는 일 |
| :- | :- |
| `lever` | stdin·stdout 으로 MCP 서버를 시작합니다. 클라이언트가 이것을 실행합니다 |
| `lever run -e 'code'`, `lever run file.js`, `lever run -` | 지금 폴더에서 코드를 한 번 실행하고 답을 찍습니다 |
| `lever install`, `lever uninstall` | Claude Code 와 Codex 에 lever 를 등록하거나 뺍니다(`--claude`, `--codex`, `--scope`, `--force`, `--dry-run`) |
| `lever doctor` | Node, ripgrep, hook, 가드 모듈, MCP 서버, 등록 상태를 점검하고 시험 실행을 한 번 합니다 |

## 개발

```sh
npm test                       # 단위 시험과 stdio 시험
npm run edge                   # 실제 서버에 엣지케이스 67개를 돌림. 모델 없음
npm run bench                  # 모델 없이 재는 측정
npm run stress -- --model haiku --repeats 3    # 실제 Claude Code 로 여러 단계 과제 11개를 잼. 본인 Claude Code 계정을 씀
node bench/stress/terminal.mjs --model haiku    # 같은 과제를 터미널 세션에서 잼. Claude Code 의 Code Mode 포함, tmux 필요
node bench/stress/selftest.mjs # 과제 채점기 자체 점검
node bench/live.mjs haiku 3    # 실제 Claude Code 로 짧은 과제 4개를 잼
```

## 앞선 작업

- [CodeAct](https://arxiv.org/abs/2402.01030)(ICML 2024): JSON 도구 호출 대신 코드로 행동하는 에이전트가 더 적은 턴으로 더 자주 성공한다는 것을 보였습니다.
- Armin Ronacher, [Your MCP Doesn't Need 30 Tools: It Needs Code](https://lucumr.pocoo.org/2025/8/18/code-mcps/)(2025년 8월)
- Cloudflare, [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/)(2025년 9월), [`@cloudflare/codemode`](https://developers.cloudflare.com/agents/tools/codemode/)
- Anthropic, [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)(2025년 11월), [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
- Claude Code 의 [Code Mode](https://code.claude.com/docs/en/code-mode)(v2.1.323), Codex 의 code mode(`features.code_mode`, 아직 개발 중)

lever 는 내 컴퓨터에서 도는 코딩 에이전트를 위한 도구입니다. 셸·파일·검색·MCP 를 도구 하나로 묶어 모든 클라이언트와 세션 종류에서 쓰게 하고, 단계마다 Claude Code 의 권한 규칙과 hook 을 그대로 거치게 합니다.

## 라이선스

MIT
