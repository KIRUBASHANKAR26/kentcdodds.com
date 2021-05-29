import nodePath from 'path'
import {Octokit} from '@octokit/rest'
import matter from 'gray-matter'
import type {GitHubFile, MdxListItem} from 'types'
import config from '../../config'

const octokit = new Octokit({
  auth: process.env.BOT_GITHUB_TOKEN,
})

async function downloadFirstMdxFile(
  list: Array<{name: string; type: string; path: string; sha: string}>,
) {
  const filesOnly = list.filter(({type}) => type === 'file')
  for (const extension of ['.mdx', '.md']) {
    const file = filesOnly.find(({name}) => name.endsWith(extension))
    if (file) return downloadFileBySha(file.sha)
  }
  return null
}

/**
 *
 * @param mdxFileOrDirectory the path to the content. For example:
 * content/workshops/react-fundamentals.mdx (pass "workshops/react-fudnamentals")
 * content/workshops/react-hooks/index.mdx (pass "workshops/react-hooks")
 * @returns A promise that resolves to an Array of GitHubFiles for the necessary files
 */
async function downloadMdxFileOrDirectory(
  relativeMdxFileOrDirectory: string,
): Promise<Array<GitHubFile>> {
  const mdxFileOrDirectory = `${config.contentSrc.path}/${relativeMdxFileOrDirectory}`
  const parentDir = nodePath.dirname(mdxFileOrDirectory)
  const dirList = await downloadDirList(parentDir)

  const basename = nodePath.basename(mdxFileOrDirectory)
  const potentials = dirList.filter(({name}) => name.startsWith(basename))

  const content = await downloadFirstMdxFile(potentials)
  // /content/about.mdx => entry is about.mdx, but compileMdx needs
  // the entry to be called "/content/index.mdx" so we'll set it to that
  // because this is the entry for this path
  if (content) {
    return [{path: nodePath.join(mdxFileOrDirectory, 'index.mdx'), content}]
  }

  const directory = potentials.find(({type}) => type === 'dir')
  if (!directory) return []

  return downloadDirectory(mdxFileOrDirectory)
}

/**
 *
 * @param mdxFileOrDirectory the path to content. For example:
 * /workshops/react-fundamentals.mdx (pass "workshops/react-fudnamentals")
 * /workshops/react-hooks/index.mdx (pass "workshops/react-hooks")
 * @returns The content of the searched for mdx file
 */
async function downloadMdxFileOrIndex(mdxFileOrDirectory: string) {
  const parentDir = nodePath.dirname(mdxFileOrDirectory)
  const dirList = await downloadDirList(parentDir)

  const basename = nodePath.basename(mdxFileOrDirectory)
  const potentials = dirList.filter(({name}) => name.startsWith(basename))

  let content = await downloadFirstMdxFile(potentials)
  if (content) return content

  const directory = potentials.find(({type}) => type === 'dir')
  // if no mdx? or directory by this name exists,
  // then we won't be getting any content here...
  if (!directory) return null

  // download the directory list to find and index.mdx? file
  const mdxDirList = await downloadDirList(directory.path)
  const indexes = mdxDirList.filter(({name}) => name.startsWith('index'))
  content = await downloadFirstMdxFile(indexes)
  if (content) return content

  return null
}

/**
 *
 * @param dir the directory to download.
 * This will recursively download all content at the given path.
 * @returns An array of file paths with their content
 */
async function downloadDirectory(dir: string): Promise<Array<GitHubFile>> {
  const dirList = await downloadDirList(dir)

  const result = await Promise.all(
    dirList.map(async ({path: fileDir, type, sha}) => {
      switch (type) {
        case 'file': {
          const content = await downloadFileBySha(sha)
          return {path: fileDir, content}
        }
        case 'dir': {
          return downloadDirectory(fileDir)
        }
        default: {
          throw new Error(`Unexpected repo file type: ${type}`)
        }
      }
    }),
  )

  return result.flat()
}

/**
 *
 * @param sha the hash for the file (retrieved via `downloadDirList`)
 * @returns a promise that resolves to a string of the contents of the file
 */
async function downloadFileBySha(sha: string) {
  const {data} = await octokit.request(
    'GET /repos/{owner}/{repo}/git/blobs/{file_sha}',
    {
      owner: config.contentSrc.owner,
      repo: config.contentSrc.repo,
      file_sha: sha,
    },
  )
  //                                lol
  const encoding = data.encoding as Parameters<typeof Buffer.from>['1']
  return Buffer.from(data.content, encoding).toString()
}

/**
 *
 * @param path the full path to list
 * @returns a promise that resolves to a file ListItem of the files/directories in the given directory (not recursive)
 */
async function downloadDirList(path: string) {
  const {data} = await octokit.repos.getContent({
    owner: config.contentSrc.owner,
    repo: config.contentSrc.repo,
    path,
  })

  if (!Array.isArray(data)) {
    throw new Error(
      `Tried to download content from ${path}. GitHub did not return an array of files. This should never happen...`,
    )
  }

  return data
}

/**
 *
 * @param relativePath the directory to download mdx frontmatter for
 * @returns the files with frontmatter attached
 */
async function downloadMdxListItemsInDir(relativePath: string) {
  const data = await downloadDirList(
    `${config.contentSrc.path}/${relativePath}`,
  )

  const result = await Promise.all(
    data
      .filter(({name}) => name !== 'README.md')
      .map(
        async ({path: fileDir}): Promise<(GitHubFile & MdxListItem) | null> => {
          const content = await downloadMdxFileOrIndex(fileDir)
          if (!content) {
            console.warn(`Could not find mdx content at path: ${fileDir}`)
            return null
          }
          const matterResult = matter(content)
          if (!Object.keys(matterResult.data).length) {
            console.warn(`Could not parse frontmatter at path: ${fileDir}`)
            return null
          }
          return {
            path: fileDir,
            content,
            slug: fileDir
              .replace(`${config.contentSrc.path}/${relativePath}`, '')
              .replace(/\.mdx?$/, ''),
            frontmatter: matterResult.data as MdxListItem['frontmatter'],
          }
        },
      ),
  )

  const files = result.filter(typedBoolean)
  return files
}

function typedBoolean<T>(
  value: T,
): value is Exclude<T, '' | 0 | false | null | undefined> {
  return Boolean(value)
}

export {downloadMdxFileOrDirectory, downloadMdxListItemsInDir}