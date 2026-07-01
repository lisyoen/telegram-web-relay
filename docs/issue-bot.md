# Issue Bot

This repository uses a lightweight GitHub Actions issue responder.

When a new issue is opened, the bot:

- posts a bilingual triage comment
- adds the `needs-triage` label
- asks for reproduction steps, logs, and environment details
- points maintainers to the `ai-candidate` label for issues that may be handled by an automated coding agent later

The first version intentionally uses only the built-in `GITHUB_TOKEN`. It does not require an external LLM key and does not execute code on behalf of issue authors.

## Labels

- `needs-triage`: new issue needs maintainer review
- `needs-repro`: bug report needs a reproducible case
- `ai-candidate`: good candidate for a future AI coding-agent workflow
- `good first issue`: suitable for first-time contributors
- `help wanted`: external contribution welcome

## Future AI Agent Flow

The next step is to connect an agent such as OpenHands, GitHub Copilot coding agent, or another GitHub-native workflow.

Recommended trigger:

1. Maintainer reviews the issue.
2. Maintainer adds `ai-candidate`.
3. Agent creates a branch and pull request.
4. Maintainer reviews the PR before merge.

This keeps public issues safe while still making the project look responsive and contributor-friendly.

---

# 이슈 봇

이 저장소는 가벼운 GitHub Actions 기반 이슈 응답 봇을 사용합니다.

새 이슈가 열리면 봇은:

- 한/영 triage 댓글을 남깁니다
- `needs-triage` 라벨을 붙입니다
- 재현 절차, 로그, 실행 환경 정보를 요청합니다
- 나중에 자동 코딩 에이전트가 처리하기 좋은 이슈에는 관리자가 `ai-candidate` 라벨을 붙일 수 있게 안내합니다

첫 버전은 일부러 GitHub 기본 `GITHUB_TOKEN`만 사용합니다. 외부 LLM 키가 필요 없고, 이슈 작성자 대신 코드를 실행하지 않습니다.

## 라벨

- `needs-triage`: 관리자의 1차 검토가 필요한 새 이슈
- `needs-repro`: 재현 가능한 사례가 더 필요한 버그
- `ai-candidate`: 향후 AI 코딩 에이전트가 처리하기 좋은 후보
- `good first issue`: 첫 기여자가 접근하기 좋은 이슈
- `help wanted`: 외부 기여를 환영하는 이슈

## 향후 AI 에이전트 흐름

다음 단계는 OpenHands, GitHub Copilot coding agent, 또는 GitHub-native 워크플로우를 연결하는 것입니다.

권장 흐름:

1. 관리자가 이슈를 검토합니다.
2. 관리자가 `ai-candidate` 라벨을 붙입니다.
3. 에이전트가 브랜치와 Pull Request를 만듭니다.
4. 관리자가 PR을 리뷰한 뒤 머지합니다.

이렇게 하면 공개 이슈를 안전하게 운영하면서도, 프로젝트가 빠르게 반응하고 기여 친화적으로 보이게 만들 수 있습니다.
