/** 将问题讲解与方案回应分开；旧稿只有合并章节时仍沿用原位置。 */
export function isPainSection(section) {
  return /痛点|挑战|困境|现状|问题/u.test(section?.heading ?? '')
    && !/方案|做法|应对/u.test(section?.heading ?? '')
}

export function relationSectionIndex(sections = []) {
  const painIndex = sections.findIndex(isPainSection)
  const solution = sections.findIndex((section, index) => index > painIndex
    && /方案|做法|应对|解决思路/u.test(section.heading ?? '')
    && !isPainSection(section))
  if (solution >= 0) return solution
  const combined = sections.findIndex(section => section.kind === 'problem_solution' && !isPainSection(section))
  if (combined >= 0) return combined
  return sections.findIndex(section => ['problem_solution', 'solution', 'pains'].includes(section.kind))
}
