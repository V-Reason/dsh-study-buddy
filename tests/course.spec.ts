import { describe, expect, test } from 'vitest'
import {
  COURSE_SCHEMA_VERSION,
  courseInventorySignature,
  parseCourseBlueprint,
  validateCourseBlueprint,
  type CourseBlueprint,
  type CourseInventory,
} from '../src/course.ts'

function blueprint(): CourseBlueprint {
  return {
    version: COURSE_SCHEMA_VERSION,
    courseId: 'demo',
    title: '输入到位移',
    outcomes: ['能重建一次冲刺的完整因果链'],
    sourceRoots: ['T:/demo'],
    coverage: [
      { scope: 'demo/Assets/Scripts', depth: 'deep', reason: '运行时主链' },
      { scope: 'demo/Assets/Resources', depth: 'index', reason: '资源入口' },
    ],
    concepts: [
      {
        id: 'input-buffer',
        name: '输入缓冲',
        priority: 'core',
        definition: '暂存短时间内的按下时刻，供后续消费。',
        introducedIn: 'R1.1',
        prerequisites: [],
        sources: ['Assets/Scripts/Logic/Input/InputBuffer.cs'],
      },
    ],
    runs: [
      {
        id: 'R1',
        title: '从按键到位移',
        goal: '解释一次冲刺如何改变刚体速度',
        entryState: '冷却剩 0.1 秒',
        endState: 'Dash 状态产生速度',
        evidence: ['Assets/Tests/移动Tests.cs'],
        lessons: [
          {
            id: 'R1.1',
            title: '按下沿',
            previousOutput: '渲染帧采样完成',
            output: '缓冲中保留 valid 时间戳',
            prerequisites: [],
            evidence: ['Assets/Scripts/Logic/Input/InputBuffer.cs'],
            boundary: '时间必须单调。',
          },
          {
            id: 'R1.2',
            title: '消费冲刺',
            previousOutput: '缓冲中保留 valid 时间戳',
            output: 'Dash 状态获得方向',
            prerequisites: ['input-buffer'],
            evidence: ['Assets/Scripts/Logic/Player/MoveGroup.cs'],
            boundary: '消费后不可回滚。',
          },
        ],
      },
    ],
  }
}

function inventory(): CourseInventory {
  return {
    version: COURSE_SCHEMA_VERSION,
    courseId: 'demo',
    createdAt: '2026-11-21T00:00:00.000Z',
    roots: [{ label: 'demo', path: 'T:/demo' }],
    files: [
      {
        root: 'demo',
        path: 'Assets/Scripts/Logic/Input/InputBuffer.cs',
        extension: '.cs',
        size: 1024,
        mtimeMs: 10,
        ctimeMs: 11,
      },
      {
        root: 'demo',
        path: 'Assets/Resources/Player.prefab',
        extension: '.prefab',
        size: 2048,
        mtimeMs: 20,
        ctimeMs: 21,
      },
    ],
    skipped: [],
  }
}

describe('课程蓝图', () => {
  test('从可见 Markdown 的 course-json 块解析并完成全量覆盖校验', () => {
    const markdown = `# 课程母图\n\n\`\`\`course-json\n${JSON.stringify(blueprint(), null, 2)}\n\`\`\`\n`
    const parsed = parseCourseBlueprint(markdown)
    const report = validateCourseBlueprint(parsed, inventory())
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
    expect(parsed.courseId).toBe('demo')
    expect(parsed.runs[0].lessons.map((lesson) => lesson.id)).toEqual(['R1.1', 'R1.2'])
  })

  test('拒绝未定义的课程位置与悬空概念依赖', () => {
    const broken = blueprint()
    broken.runs[0].lessons[0].id = 'R1.1'
    broken.runs[0].lessons[1].prerequisites = ['missing-concept']
    broken.concepts[0].introducedIn = 'R9.9'
    const report = validateCourseBlueprint(broken, inventory())
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('概念 input-buffer 的 introducedIn 不存在'),
      expect.stringContaining('课程 R1.2 依赖未定义概念 missing-concept'),
    ]))
  })

  test('拒绝未进入覆盖矩阵的来源文件', () => {
    const uncovered = inventory()
    uncovered.files.push({
      root: 'demo',
      path: 'Docs/EngineNotes.md',
      extension: '.md',
      size: 128,
      mtimeMs: 30,
      ctimeMs: 31,
    })
    const report = validateCourseBlueprint(blueprint(), uncovered)
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('来源未被覆盖矩阵覆盖：demo/Docs/EngineNotes.md'),
    ]))
  })

  test('拒绝课程蓝图与来源清单使用不同来源根', () => {
    const wrongRoot = blueprint()
    wrongRoot.sourceRoots = ['T:/other']
    const report = validateCourseBlueprint(wrongRoot, inventory())
    expect(report.errors).toContain('课程来源根与已生成清单不一致')
  })

  test('拒绝概念前置依赖成环', () => {
    const cyclic = blueprint()
    cyclic.concepts[0].prerequisites = ['second']
    cyclic.concepts.push({
      id: 'second',
      name: '第二概念',
      priority: 'support',
      definition: '用于制造环。',
      introducedIn: 'R1.2',
      prerequisites: ['input-buffer'],
      sources: ['Assets/Scripts/Logic/Input/InputBuffer.cs'],
    })
    const report = validateCourseBlueprint(cyclic, inventory())
    expect(report.errors.some((error) => error.includes('概念前置依赖成环'))).toBe(true)
  })

  test('来源签名对路径、大小与时间变化敏感', () => {
    const base = courseInventorySignature(inventory())
    const changed = inventory()
    changed.files[0].mtimeMs += 1
    expect(courseInventorySignature(changed)).not.toBe(base)
  })
})
