import {Util} from './util';
import {Scope} from './evaluables';
import {BlockStore, LabelStore} from './blocks';
import {TJumpOp, JumpOp} from'./ops';
import {Group, GroupStore} from './group';
import {CommandTree, Parser} from './parser';
import {Executor} from './executor';

type InstanceMap = {[name: string]: Entity[]};

interface IBoardConfig {
    autoStep: boolean;
    parser: Parser;
};

export class Entity {
    //properties
    id: string;
    board: Board;
    name: string;
    script: Function;
    initParams: string[];
    depth: number;
    parent: Entity;
    //state
    variables: {[name: string]: any};
    adoptions: CommandTree[];
    groups: string[];
    ended: boolean;
    cycleEnded: boolean;
    locked: boolean;
    pendingJumpOp: TJumpOp;
    //execution
    executor: Executor;

    constructor(board: Board, name: string, script: Function, initParams: string[] = []) {
        this.id = Util.generateId().toString();
        this.board = board;
        this.name = name;
        this.script = script;
        this.initParams = initParams;
        this.depth = 0;
        this.parent = null;
        this.variables = {};
        this.adoptions = [];
        this.groups = [];
        this.ended = false;
        this.cycleEnded = false;
        this.locked = false;
        this.pendingJumpOp = null;
        this.executor = null;
    }

    static clone(entity: Entity): Entity {
        return new Entity(entity.board, entity.name, entity.script, entity.initParams);
    }

    begin(initArgs: any[]): void {
        this.cycleEnded = false;
        this.gotoLabel('init', initArgs);
    }

    gotoLabel(labelName: string, args: any[]): void {
        if (this.locked || !this.executor.labelStore.hasEnabled(labelName)) {
            return;
        }

        this.pendingJumpOp = JumpOp.create(labelName, args);
        this.ended = false;
        this.cycleEnded = false;
    }

    execute(): void {
        this.cycleEnded = false;

        if (this.ended) {
            return;
        }

        //TODO - needed in case an object sends a message to itself. Figure out a better way to do this?
        if (this.pendingJumpOp) {
            this.executor.execJumpOp(this.pendingJumpOp);
            this.pendingJumpOp = null;
        }

        while (this.executor.step()) {
            if (this.cycleEnded || this.ended) {
                break;
            }
            if (this.pendingJumpOp) {
                this.executor.execJumpOp(this.pendingJumpOp);
                this.pendingJumpOp = null;
            }
        }
    }

    destroyAdoptions(): void {
        for (let commandSet of this.adoptions) {
           commandSet['__destroy__']();
        }
        this.adoptions = [];
    }
}

export class Board extends Entity {
    //Setup
    setupFunc: Function;
    finishFunc: Function;
    runScript: Function;
    objects: {[name: string]: Entity};
    autoStep: boolean;
    parser: Parser;

    //Execution
    instances: InstanceMap[];
    spawnedObjs: Entity[];
    deletedObjs: Entity[];
    groupStore: GroupStore;
    terminated: boolean;

    constructor() {
        super(null, "_board", null, []);

        this.setupFunc = function () {};
        this.finishFunc = function () {};
        this.runScript = function () {};
        this.objects = {};
        this.autoStep = false;
        this.parser = null;
        this.instances = [{}];
        this.spawnedObjs = [];
        this.deletedObjs = [];
        this.groupStore = new GroupStore();
        this.terminated = false;

        //TODO - make this null
        this.board = this;
    }

    setup(func: Function): Board {
        this.setupFunc = func;
        return this;
    }

    run(script: Function): Board {
        this.runScript = script;
        return this;
    }

    finish(func: Function): Board {
        this.finishFunc = func;
        return this;
    }

    configure(config: IBoardConfig): Board {
        this.autoStep = config.autoStep || false;
        this.parser = config.parser || new Parser();
        return this;
    }

    start(): void {
        //Run setup
        (new Function(
            'var object = this.defineObject.bind(this);' +
            'var group = this.defineGroup.bind(this);' +
            this.setupFunc.toString().replace("function ()", "")
        )).call(this);

        //Run root entity script
        this.script = this.runScript;
        this.depth = 0;
        this.parent = null;
        this.executor = this.parser.parse(this);
        this.begin([]);
        this.instances[0]["_board"] = [];
        this.instances[0]["_board"].push(this);

        //Begin execution loop
        if (this.autoStep) {
            while (!this.terminated) {
                this.step();
            }
        }
    }

    step(): void {
        if (this.terminated) {
            return;
        }

        //Add spawned objects
        for (let i = 0; i < this.spawnedObjs.length; i++) {
            if (!this.instances[this.spawnedObjs[i].depth][this.spawnedObjs[i].name])
                this.instances[this.spawnedObjs[i].depth][this.spawnedObjs[i].name] = [];

            this.instances[this.spawnedObjs[i].depth][this.spawnedObjs[i].name].push(this.spawnedObjs[i]);
        }
        this.spawnedObjs = [];

        //Purge dead objects
        for (let i = 0; i < this.deletedObjs.length; i++) {
            this.instances[this.deletedObjs[i].depth][this.deletedObjs[i].name].splice(
                this.instances[this.deletedObjs[i].depth][this.deletedObjs[i].name].indexOf(this.deletedObjs[i]), 1);
        }
        this.deletedObjs = [];

        //Execute object tree
        for (let i = this.instances.length - 1; i >= 0; i--) {
            for (let objName in this.instances[i]) {
                for (let j = 0; j < this.instances[i][objName].length; j++) {
                    this.instances[i][objName][j].execute();
                }
            }
        }

        if (this.terminated) {
            this.finishFunc();
        }
    }

    defineObject(name: string, initParamsOrScript: string[] | Function, script?: Function): Entity {
        if (this.objects[name]) {
            throw "Duplicate object definition";
        }

        let obj;
        if (arguments.length === 3) {
            obj = new Entity(this, name, script, <string[]>initParamsOrScript);
        }
        else if (arguments.length === 2) {
            obj = new Entity(this, name, <Function>initParamsOrScript, []);
        }
        else {
            throw "Bad object definition";
        }

        this.objects[name] = obj;

        return obj;
    }

    isObjectDefined(name: string): boolean {
        return this.objects[name] != null;
    }

    spawnObject(name: string, parent: Entity, initArgs: any[]): Entity {
        if (!this.objects[name])
            return;

        if (parent) {
            if (this.instances.length <= parent.depth + 1)
                this.instances.push({});
        }

        let obj = Entity.clone(this.objects[name]);
        obj.depth = parent ? parent.depth + 1 : 0;
        obj.parent = parent || obj;
        obj.executor = this.parser.parse(obj);
        obj.begin(initArgs);

        this.spawnedObjs.push(obj);

        return obj;
    }

    removeObject(entity: Entity, recursive?: boolean): void {
        if (recursive) {
            for (let child of this.getChildObjects(entity)) {
                this.removeObject(child);
            }
        }

        entity.locked = true;
        entity.ended = true;
        entity.cycleEnded = true;
        entity.destroyAdoptions();

        this.removeObjectFromAllGroups(entity);
        this.deletedObjs.push(entity);
    }

    replaceObject(target: Entity, newName: string, initArgs: any[]): void {
        let newObject = this.spawnObject(this.objects[newName].name, target.parent, initArgs);
        for (let child of this.getChildObjects(target)) {
            child.parent = newObject;
        }
        this.removeObject(target);
    }

    getChildObjects(entity: Entity): Entity[] {
        if (entity.depth + 1 >= this.instances.length) {
            return [];
        }

        let children = [];

        for (let name in this.instances[entity.depth + 1]) {
            for (let obj of this.instances[entity.depth + 1][name]) {
                if (obj.parent === entity) {
                    children.push(obj);
                }
            }
        }

        for (let obj of this.spawnedObjs) {
            if (obj.parent === entity) {
                children.push(obj);
            }
        }

        return children;
    }

    defineGroup(groupName: string): void {
        this.groupStore.defineGroup(groupName);
    }

    isGroupDefined(groupName: string): boolean {
        return this.groupStore.hasGroup(groupName);
    }

    addObjectToGroup(groupName: string, entity: Entity): void {
        if (!this.groupStore.hasGroup(groupName)) {
            return;
        }

        this.groupStore.get(groupName).addEntity(entity);
        entity.groups.push(groupName);
    }

    removeObjectFromGroup(groupName: string, entity: Entity): void {
        if (!this.groupStore.hasGroup(groupName))
            return;

        this.groupStore.get(groupName).removeEntity(entity);
        entity.groups.splice(entity.groups.indexOf(groupName), 1);
    }

    removeObjectFromAllGroups(entity: Entity): void {
        for (let i = entity.groups.length - 1; i >= 0; i--) {
            this.removeObjectFromGroup(entity.groups[i], entity);
        }
    }

    getObjectsInGroup(groupName: string): Entity[] {
        if (!this.groupStore.hasGroup(groupName)) {
            return null;
        }

        return this.groupStore.get(groupName).getEntities();
    }

    terminate(): void {
        this.terminated = true;
    }
}

export class World {
    boards: {[name: string]: Board};
    activeBoard: Board;

    constructor() {
        this.boards = {};
        this.activeBoard = null;
    }

    addBoard(name: string, board: Board): void {
        this.boards[name] = board;
    }

    startBoard(name: string): void {
        this.activeBoard = this.boards[name];
        this.activeBoard.start();
    }

    step(): void {
        if (!this.activeBoard) {
            return;
        }

        this.activeBoard.step();
    }
}