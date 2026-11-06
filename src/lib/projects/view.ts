import type { BriefFileInfo } from '@/components/app/BriefFilesField'
import type { ProjectView } from '@/components/app/ProjectDetails'
import type { BriefFile, Project } from '@/payload-types'

import { type ProjectInput, storedToDay } from './fields'

/** The project's brief files that were populated (read with depth 1), for the page. */
export const briefFilesOf = (project: Project): BriefFileInfo[] =>
  (project.attachments ?? [])
    .filter((a): a is BriefFile => typeof a === 'object' && a !== null)
    .map((file) => ({
      id: file.id,
      name: file.originalName ?? file.filename ?? 'file',
      size: file.filesize,
      url: file.url,
    }))

/** A stored project as the form's values. */
export const projectToInput = (project: Project): ProjectInput => ({
  title: project.title ?? '',
  description: project.description ?? '',
  tasks: project.tasks ?? '',
  desiredSkills: (project.desiredSkills ?? []).join(', '),
  workloadHours: project.workloadHours ? String(project.workloadHours) : '',
  durationWeeks: project.durationWeeks ? String(project.durationWeeks) : '',
  startDate: storedToDay(project.startDate) ?? '',
  workMode: project.workMode ?? '',
  location: project.location ?? '',
  deadline: storedToDay(project.deadline) ?? '',
  deliverable: project.deliverable ?? '',
  paidOrUnpaid: project.paidOrUnpaid ?? '',
  unpaidBenefit: project.unpaidBenefit ?? '',
  attachments: briefFilesOf(project).map((file) => file.id),
})

/** A stored project for ProjectDetails, with its attachments for the company's own view. */
export const projectToView = (project: Project): ProjectView => ({
  description: project.description ?? null,
  tasks: project.tasks ?? null,
  desiredSkills: project.desiredSkills ?? [],
  workloadHours: project.workloadHours ?? null,
  durationWeeks: project.durationWeeks ?? null,
  startDate: storedToDay(project.startDate),
  deadline: storedToDay(project.deadline),
  workMode: project.workMode ?? null,
  location: project.location ?? null,
  deliverable: project.deliverable ?? null,
  paidOrUnpaid: project.paidOrUnpaid ?? null,
  unpaidBenefit: project.unpaidBenefit ?? null,
  attachments: briefFilesOf(project),
})
