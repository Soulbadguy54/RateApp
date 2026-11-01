/** Public history of production *batches*, not commits, pull requests, staging
 * previews or workflow retries. It begins with the first verified VPS
 * production release on 21 October 2026. Earlier Vercel per-commit previews
 * are not retroactively classified as packaged product releases.
 *
 * The first entry is the next planned batch. Append only prominent user-facing
 * changes while working in develop, then create a new batch for the next release.
 * Internal deployment audit metadata is never shown in the modal.
 */
export type PublicRelease = Readonly<{
  version: string
  period: string
  changes: readonly string[]
  productionSha?: string
  deploymentRun?: number
}>

export const RELEASE_NOTES: readonly PublicRelease[] = [
  {
    version: "26.11.001",
    period: "Ноябрь 2026",
    changes: [
      "Подключение Steam и синхронизация игр со своей библиотекой Rate APP.",
      "Ручной поиск игр из Steam и удобное связывание найденных совпадений.",
      "Обновлённый профиль: любимые игры, собственный аватар и цвета оформления.",
      "Раздел «Мои ссылки» для сохранения игровых материалов и поиска игр в них."
    ],
  },
  {
    version: "26.10.012",
    period: "Октябрь 2026",
    changes: [
      "Удобнее возвращаться назад между экранами игр и коллекций."
    ],
    productionSha: "2b4b61865d749ebaf83fd3c2ae5ac435ab5c94bb",
    deploymentRun: 40478930712,
  },
  {
    version: "26.10.011",
    period: "Октябрь 2026",
    changes: [],
    productionSha: "b157411a745cebbe8f82cb7d2ab6458d35bdd203",
    deploymentRun: 40464237265,
  },
  {
    version: "26.10.010",
    period: "Октябрь 2026",
    changes: [
      "Если сессия завершилась, приложение понятно предлагает войти заново."
    ],
    productionSha: "f0b2b92273cbf796e40d6e1b297545373f69bfa6",
    deploymentRun: 40458962549,
  },
  {
    version: "26.10.009",
    period: "Октябрь 2026",
    changes: [
      "Появился раздел «Для тебя» с персональными игровыми рекомендациями.",
      "Новые жесты для просмотра и оценки рекомендаций."
    ],
    productionSha: "d9add1d67deef72f27338e44f80e034e3486e889",
    deploymentRun: 40444398986,
  },
  {
    version: "26.10.008",
    period: "Октябрь 2026",
    changes: [],
    productionSha: "dab7455468d071ef4b3100c6407d8ab4f769fe9c",
    deploymentRun: 40433017126,
  },
  {
    version: "26.10.007",
    period: "Октябрь 2026",
    changes: [],
    productionSha: "7052c62ba973dd118ded307a2cf0ddf2ffc6dadc",
    deploymentRun: 40388368461,
  },
  {
    version: "26.10.006",
    period: "Октябрь 2026",
    changes: [],
    productionSha: "a00398526a70c3dc04f36a53efabab8a87db33ae",
    deploymentRun: 40379704025,
  },
  {
    version: "26.10.005",
    period: "Октябрь 2026",
    changes: [],
    productionSha: "3420b9f9f125d94dd9b572609fd7d18a97520eba",
    deploymentRun: 40013388850,
  },
  {
    version: "26.10.004",
    period: "Октябрь 2026",
    changes: [],
    productionSha: "a347f9b4bb0bfc71d1218d60e55a1392d49dcbe9",
    deploymentRun: 39602408020,
  },
  {
    version: "26.10.003",
    period: "Октябрь 2026",
    changes: [
      "Стало понятнее, как включить уведомления о выходе ожидаемых игр."
    ],
    productionSha: "4ec5d49f9e939b51844488a8883b540e804c4054",
    deploymentRun: 39601474003,
  },
  {
    version: "26.10.002",
    period: "Октябрь 2026",
    changes: [],
    productionSha: "2a5270f41a1dca4ab176538e3a9e2c7c7d7f178e",
    deploymentRun: 39593200494,
  },
  {
    version: "26.10.001",
    period: "Октябрь 2026",
    changes: [
      "Личная библиотека игр, оценки, коллекции и список «Хочу пройти» — основа Rate APP."
    ],
    deploymentRun: 39589259838,
  },
] as const

/** Version shown to users, independent of SHA and staging iterations. */
export const CURRENT_RELEASE_VERSION = RELEASE_NOTES[0].version
