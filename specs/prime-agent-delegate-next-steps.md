# Prime Agent Delegate: состояние после v1.0.0

Дата проверки: 2026-09-02
Репозиторий: `C:\Project\Prime-agent-delegate`

## Что реализовано

- Окно `no_change_progress` для RPC запускается после принятия prompt, а не при spawn.
- Для CLI окно запускается после первого валидного события, поскольку отдельного
  подтверждения prompt в этом transport нет.
- `audit-summary.json` содержит read/write split, позицию первой правки и число
  tool calls до неё.
- События получают delegate-side поле `capturedAt`.
- Классификатор audit-метрик не считает `content` достаточным признаком записи,
  игнорирует перенаправление в `/dev/null` и распознаёт Python file writes внутри
  `bash`/`ipython`.
- Полный WSL suite проходит: 90/90.
- Repository-source smoke завершён с `status=completed`, `normal_exit`, полным
  протоколом и без изменений вне allowlist.
- Source и installed skill совпадают по SHA-256; installed check подтверждает
  Prime Agent 0.9.1 и `ok: true`.
- Installed-skill smoke также завершён с `status=completed`, `normal_exit`, полным
  протоколом и корректной first-edit evidence.

Audit-классификация остаётся эвристикой. Источником истины для фактических
изменений являются Git diff и watchdog.

## Публикация

Следующий релиз для этого набора изменений: `v1.0.1`. Перед публикацией выполнены
полный suite, source-smoke, installed parity/check и installed-smoke.

## Отдельная уборка, не блокирующая релиз

- Проверить необходимость `stash@{0}` перед удалением.
- Удалить `prime-first-edit-budget` только если worktree чистый и отдельный commit
  `027031f` больше не нужен.
- Проверять `smoke-test` только через marker + age + clean-Git правила; не удалять
  его принудительно.

## Критерий завершения

Source и installed skill совпадают по SHA-256, оба smoke завершаются успешно,
полный WSL suite зелёный, `main` чистый и синхронизирован с GitHub, а `v1.0.1`
указывает на проверенный commit.
