# dailylife-utils

## Apps

| App | Summary |
| --- | --- |
| [repo](/Users/lutz/projects/myaerocode/dailylife-utils/apps/repo/README.md) | configured paths 아래의 GitHub repository 를 찾아서 리스트/선택하는 CLI 앱 |

## Versioning

- 각 앱은 자신의 `apps/<name>/package.json` `version`으로 semver 관리한다.
- `apps/<name>/` 아래 파일이 staged 되었으면 같은 앱의 `package.json` version 도 함께 올라가야 한다.
- 이 규칙은 git `pre-commit` hook 으로 강제된다.
- 커밋 메시지는 conventional commit 형식을 따라야 한다.
- 이 규칙은 git `commit-msg` hook 으로 강제된다.
- 커밋 메시지 요약은 가능하면 한글을 우선 사용한다. 이 항목은 권장 사항이다.
