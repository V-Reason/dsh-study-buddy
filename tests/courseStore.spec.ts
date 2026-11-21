import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { COURSE_SCHEMA_VERSION, type CourseBlueprint, type CourseState } from '../src/course.ts'
import { VaultStore } from '../src/index.ts'

function courseBlueprint(): CourseBlueprint {
  return {
    version: COURSE_SCHEMA_VERSION,
    courseId: 'demo',
    title: '一次输入链路',
    outcomes: ['能重建从按下到位移的链路'],
    sourceRoots: ['project'],
    coverage: [
      { scope: 'Assets', depth: 'deep', reason: '主运行链' },
      { scope: 'Docs', depth: 'reference', reason: '设计依据' },
    ],
    concepts: [
      {
        id: 'buffer',
        name: '输入缓冲',
        priority: 'core',
        definition: '保留短时间内的按下。',
        introducedIn: 'R1.1',
        prerequisites: [],
        sources: ['Assets/Input.cs'],
      },
    ],
    runs: [
      {
        id: 'R1',
        title: '输入到位移',
        goal: '解释一次冲刺',
        entryState: '采样帧完成',
        endState: '刚体速度改变',
        evidence: ['Assets/Input.cs'],
        lessons: [
          {
            id: 'R1.1',
            title: '缓冲',
            previousOutput: '按下沿进入采样器',
            output: '按下时刻可被消费',
            prerequisites: [],
            evidence: ['Assets/Input.cs'],
            boundary: '时间必须单调。',
          },
          {
            id: 'R1.2',
            title: '消费',
            previousOutput: '按下时刻可被消费',
            output: '速度状态被提交',
            prerequisites: ['buffer'],
            evidence: ['Assets/Input.cs'],
            boundary: '提交只能发生在帧窗口内。',
          },
        ],
      },
    ],
  }
}

function markdown(blueprint: CourseBlueprint): string {
  return `# 课程母图\n\n\`\`\`course-json\n${JSON.stringify(blueprint, null, 2)}\n\`\`\`\n`
}

let vault: string
let project: string
let store: VaultStore
let blueprintPath: string

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'study-buddy-course-'))
  project = await mkdtemp(join(tmpdir(), 'study-buddy-project-'))
  await mkdir(join(project, 'Assets'), { recursive: true })
  await mkdir(join(project, 'Docs'), { recursive: true })
  await writeFile(join(project, 'Assets', 'Input.cs'), 'class Input {}\n')
  await writeFile(join(project, 'Docs', 'Design.md'), '# Design\n')
  await mkdir(join(vault, '课程'), { recursive: true })
  blueprintPath = join(vault, '课程', '课程母图.md')
  const blueprint = courseBlueprint()
  blueprint.sourceRoots = [project]
  await writeFile(blueprintPath, markdown(blueprint), 'utf8')
  store = new VaultStore({
    vaultRoot: vault,
    stateDir: '.study',
    fallbackDir: '未分类',
    searchRoots: [project],
    maxWalkFiles: 100,
  })
})

afterEach(async () => {
  await rm(vault, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('study_course 持久化与门禁', () => {
  test('inventory → validate → activate → position 形成可恢复课程状态', async () => {
    const inventory = await store.studyCourse('inventory', {
      courseId: 'demo',
      roots: [project],
    })
    expect(inventory).toContain('来源清单已生成')
    expect(inventory).toContain('Assets/Input.cs')

    const validation = await store.studyCourse('validate', { blueprintRef: '课程/课程母图.md' })
    expect(validation).toContain('课程验证通过')

    const activated = await store.studyCourse('activate', { blueprintRef: '课程/课程母图.md' })
    expect(activated).toContain('课程已激活')
    expect(activated).toContain('R1 / R1.1')

    const positioned = await store.studyCourse('position', {
      run: 'R1',
      lesson: 'R1.1',
      previousOutput: '按下沿已采样',
      mapSlice: '输入 → 缓冲',
    })
    expect(positioned).toContain('按下沿已采样')

    const state = JSON.parse(await readFile(join(vault, '.study', 'course.json'), 'utf8')) as CourseState
    expect(state).toMatchObject({
      status: 'active',
      courseId: 'demo',
      currentRun: 'R1',
      currentLesson: 'R1.1',
      previousOutput: '按下沿已采样',
      mapSlice: '输入 → 缓冲',
    })

    const brief = await store.progress('brief', {})
    expect(brief).toContain('课程：一次输入链路（demo）')
    expect(brief).toContain('课程位置：R1 / R1.1')
    expect(brief).toContain('课程上一输出：按下沿已采样')
  })

  test('来源变化后状态变为 stale 并拒绝推进课程', async () => {
    await store.studyCourse('inventory', { courseId: 'demo', roots: [project] })
    await store.studyCourse('activate', { blueprintRef: '课程/课程母图.md' })
    await writeFile(join(project, 'Assets', 'Input.cs'), 'class InputChanged {}\n')

    const status = await store.studyCourse('status', {})
    expect(status).toContain('来源已变化')
    await expect(store.studyCourse('position', {
      run: 'R1',
      lesson: 'R1.1',
      previousOutput: 'x',
    })).rejects.toThrow(/来源已变化/)
  })

  test('蓝图编辑后旧激活状态失效', async () => {
    await store.studyCourse('inventory', { courseId: 'demo', roots: [project] })
    await store.studyCourse('activate', { blueprintRef: '课程/课程母图.md' })
    await writeFile(blueprintPath, `${markdown(courseBlueprint())}\n新增说明\n`, 'utf8')
    expect(await store.studyCourse('status', {})).toContain('蓝图已变化')
  })

  test('重新激活同一课程时保留仍存在的当前讲次', async () => {
    await store.studyCourse('inventory', { courseId: 'demo', roots: [project] })
    await store.studyCourse('activate', { blueprintRef: '课程/课程母图.md' })
    await store.studyCourse('position', {
      run: 'R1',
      lesson: 'R1.2',
      previousOutput: '按下时刻已进入状态消费',
    })
    const revised = courseBlueprint()
    revised.sourceRoots = [project]
    await writeFile(blueprintPath, `${markdown(revised)}\n课程说明更新\n`, 'utf8')
    const activated = await store.studyCourse('activate', { blueprintRef: '课程/课程母图.md' })
    expect(activated).toContain('R1 / R1.2')
  })

  test('未知 action 抛错而不是静默', async () => {
    await expect(store.studyCourse('bogus', {})).rejects.toThrow(/未知 action/)
  })
})
