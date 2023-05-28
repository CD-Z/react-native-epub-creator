import EpubFile, { EpubChapter, EpubSettings } from "@cd-z/epub-constructor";
import * as fs from "expo-file-system";
import { zip } from "react-native-zip-archive";
import {
  exists,
  mkdir,
  moveFile,
  openDocumentTree,
  unlink,
  writeFile,
} from "react-native-saf-x";

const getEpubfileName = (name: string) => {
  return name.endsWith(".epub") ? name : name + ".epub";
};

const validateDir = async (path: string) => {
  path = getFolderPath(path);
  if (!(await exists(path))) {
    await mkdir(path);
  }
};
const removeDir = async (path: string) => {
  if (await exists(path)) {
    await unlink(path);
  }
};

const checkFile = (path: string) => {
  var name = path.split("/").reverse()[0].toLocaleLowerCase();
  var fileExtension = [
    ".json",
    ".html",
    ".xml",
    ".opf",
    ".ncx",
    ".css",
    "mimetype",
    ".epub",
  ];
  var fileInfo = {
    isDirectory: !fileExtension.find((x) => name.indexOf(x) !== -1),
    folderPath:
      path.split("/").length > 1 &&
      fileExtension.find((x) => name.indexOf(x) !== -1)
        ? path
            .split("/")
            .reverse()
            .filter((x, index) => index > 0)
            .reverse()
            .join("/")
        : path,
  };
  return fileInfo;
};

const getFolderPath = (path: string) => {
  var file = checkFile(path);
  return file.folderPath;
};

export default class EpubBuilder {
  private settings: EpubSettings;
  private outputPath?: string;
  private tempPath?: string;
  private tempOutputPath: string;
  private fileName: string;
  private dProgress: number = 0;
  private prepared: boolean = false;

  static onProgress?: (
    progress: number,
    epubFile: string,
    operation:
      | "constructEpub"
      | "SaveFile"
      | "LoadingFile"
      | "Zip"
      | "Unzip"
      | "Reading"
      | "Finished"
  ) => void;

  public onSaveProgress?: (
    progress: number,
    epubFile: string,
    operation: "constructEpub" | "SaveFile" | "Finished"
  ) => Promise<void>;

  /*
    destinationFolderPath: destination to the folder, You could use react-native-fs RNFS.DownloadDirectoryPath
    */
  constructor(settings: EpubSettings, destinationFolderPath?: string) {
    this.settings = settings;
    this.fileName = this.settings.fileName ?? this.settings.title;
    this.tempOutputPath = fs.cacheDirectory + "output/";
    this.outputPath = destinationFolderPath
      ? getFolderPath(destinationFolderPath)
      : undefined;
  }

  public getEpubSettings() {
    return this.settings;
  }

  /*
        This will prepare a temp folder that contains the data of the epub file.
        the folder will be descarded when the epub file is created eg save() or discardChanges() 
    */
  public async prepare() {
    this.prepared = true;
    await this.createTempFolder();
    if (!this.settings.chapters) {
      this.settings.chapters = [] as EpubChapter[];
    }
    return this;
  }
  /*
        discard all changes
    */
  public async discardChanges() {
    try {
      if (this.tempPath) {
        await removeDir(this.tempPath);
        await removeDir(this.tempOutputPath);
      }
      this.tempPath = undefined;
    } catch (error) {
      throw error;
    }
  }
  /*
        add a new Chapter
    */
  public async addChapter(epubChapter: EpubChapter) {
    if (!this.prepared || !this.settings.chapters) {
      throw new Error("Please run the prepare method first");
    }
    this.settings.chapters.push(epubChapter);
  }

  /*
    destinationFolderPath: destination to the folder, You could use react-native-fs RNFS.DownloadDirectoryPath
    RNFS: file reader settings best use with react-native-fs eg import * as RNFS from 'react-native-fs', or you could use your own filereder
    removeTempFile(default true) set to false if there will be other changes to the epub file so it wont have to recreate the temp folder
    */
  public async save(removeTempFile?: boolean) {
    const epubFileName = getEpubfileName(this.fileName);
    const tempOutputFile = this.tempOutputPath + epubFileName;

    if (!this.prepared) {
      await this.createTempFolder();
    }
    const outputFile = `${this.outputPath}/${epubFileName}`;

    await this.populate();
    await removeDir(this.tempOutputPath);

    if (this.tempPath) {
      await validateDir(this.tempOutputPath);
      await zip(this.tempPath, tempOutputFile);

      await fs.getContentUriAsync(tempOutputFile).then(async (contentUri) => {
        await moveFile(contentUri, outputFile, {
          replaceIfDestinationExists: true,
        }).catch((e) => console.log(e, contentUri, outputFile));
      });
    }

    if (removeTempFile !== false) {
      await this.discardChanges();
    }

    return outputFile;
  }

  private async pickFolder() {
    const folder = await openDocumentTree(true);
    if (folder) {
      this.outputPath = folder.uri;
      return;
    }
    throw new Error("No permissions to access destination folder granted.");
  }

  private async createTempFolder() {
    this.tempPath = fs.cacheDirectory + "epubCreation/" + this.fileName;
    await validateDir(this.tempPath);

    if (!this.outputPath) {
      await this.pickFolder();
    }
  }

  public async populate() {
    var overrideFiles = ["toc.ncx", "toc.html", ".opf", ".json"];
    const epub = new EpubFile(this.settings);
    const files = await epub.constructEpub(async (progress) => {
        EpubBuilder.onProgress?.(this.dProgress, this.fileName, "constructEpub");
      if (this.onSaveProgress) {
        await this.onSaveProgress?.(progress, this.fileName, "constructEpub");
      }
    });

    this.dProgress = 0;

    var len = files.length + 1;
    for (var i = 0; i < files.length; i++) {
      this.dProgress = (i / parseFloat(len.toString())) * 100;
      const file = files[i];
      var path = this.tempPath + "/" + file.path;
      if (
        overrideFiles.find((f) => file.path.indexOf(f) !== -1) &&
        (await exists(path))
      ) {
        await unlink(path);
      }
      var fileSettings = checkFile(file.path);
      if (!fileSettings.isDirectory) {
        await validateDir(path);
      }
      if (!(await exists(path))) {
        if (file.format) {
          await validateDir(this.tempPath + "/OEBPS/images");
          await fs.downloadAsync(file.content, path);
        } else {
          await writeFile(path, file.content);
        }
      }
      if (this.outputPath) {
        const operation =
          Math.round(this.dProgress) === 100 ? "Finished" : "SaveFile";
        EpubBuilder.onProgress?.(this.dProgress, this.fileName, operation);
        if (this.onSaveProgress) {
          await this.onSaveProgress?.(this.dProgress, this.fileName, operation);
        }
      }
    }
  }

  /*
    epubPath: path to the epub file
    RNFS: file reader settings best use with react-native-fs eg import * as RNFS from 'react-native-fs', or you could use your own filereder
    */
  //   static async loadEpub(
  //     epubPath: string,
  //     RNFS: FsSettings,
  //     localOnProgress?: (progress: number, file: string) => void
  //   ) {
  //     return await EpubLoader(epubPath, RNFS, localOnProgress);
  //   }
}

