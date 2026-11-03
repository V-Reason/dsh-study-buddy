import { describe, expect, test } from 'vitest'
import { formatStudyBrief, normalizeBriefText, normalizeParallelLines } from '../src/studyBrief.ts'

describe('学习简报', () => {
  test('只输出当前主线、下一步、判据和精简并行线', () => {
    const text = formatStudyBrief({
      planRef: '2026-10至2027-01_全量计划表.md',
      phase: 'B 3D 数学与流程',
      nextAction: '完成四元数与 Slerp 最小验证',
      doneWhen: '能不用参照写出旋转插值并解释万向锁',
      lastOutcome: '相机投影已完成',
      parallelLines: ['算法：链表', '投递：11 月 9 日小批试投'],
      updatedAt: '2026-11-03T04:00:00.000Z',
    })
    expect(text).toContain('阶段：B 3D 数学与流程')
    expect(text).toContain('下一步：完成四元数与 Slerp 最小验证')
    expect(text).toContain('完成判据：能不用参照写出旋转插值并解释万向锁')
    expect(text).toContain('算法：链表')
    expect(text).not.toContain('复习')
    expect(text).not.toContain('提醒')
  })

  test('文本与并行线有确定上限', () => {
    expect(normalizeBriefText('  B 3D  ', 'phase')).toBe('B 3D')
    expect(() => normalizeBriefText('a\nb', 'phase')).toThrow('不能包含换行')
    expect(normalizeParallelLines([' 算法：链表 ', '算法：链表', ''])).toEqual(['算法：链表'])
  })
})
