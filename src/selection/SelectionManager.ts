import { EditorSignals } from '../Editor';
import { GeometryDatabase } from '../GeometryDatabase';
import MaterialDatabase from '../MaterialDatabase';
import { RefCounter } from '../Util';
import { Curve3D, CurveEdge, CurveSegment, Face, Solid, SpaceInstance, TopologyItem } from '../VisualModel';
import { ClickStrategy } from './Click';
import { Hoverable, HoverStrategy } from './Hover';
import * as visual from '../VisualModel';

export enum SelectionMode {
    Edge, Face, Solid, Curve
}

export interface SelectionStrategy {
    emptyIntersection(): void;
    solid(object: TopologyItem, parentItem: Solid): boolean;
    topologicalItem(object: TopologyItem, parentItem: Solid): boolean;
    curve3D(object: CurveSegment, parentItem: SpaceInstance<Curve3D>): boolean;
    invalidIntersection(): void;
}

export class SelectionManager {
    readonly selectedSolids = new Set<Solid>();
    readonly selectedChildren = new RefCounter();
    readonly selectedEdges = new Set<CurveEdge>();
    readonly selectedFaces = new Set<Face>();
    readonly selectedCurves = new Set<SpaceInstance<Curve3D>>();
    readonly mode = new Set<SelectionMode>([SelectionMode.Solid, SelectionMode.Edge, SelectionMode.Curve, SelectionMode.Face]);
    hover?: Hoverable = null;

    private readonly clickStrategy = new ClickStrategy(this);
    private readonly hoverStrategy = new HoverStrategy(this);

    constructor(
        readonly db: GeometryDatabase,
        readonly materials: MaterialDatabase,
        readonly signals: EditorSignals
    ) {}

    // FIXME make this method just take an array of objects
    private onIntersection(intersections: THREE.Intersection[], strategy: SelectionStrategy) {
        if (intersections.length == 0) {
            strategy.emptyIntersection();
            return;
        }

        console.log(intersections.length, intersections)
        intersections.sort((i1, i2) => {
            const a = i1.object, b = i2.object;
            if (a instanceof visual.CurveEdge && b instanceof visual.Face) {
                return -1;
            } else if (a instanceof visual.Face && b instanceof visual.CurveEdge) {
                return 1;
            } else {
                return 0;
            }
        });

        console.log(">>>>>>>>>>>>>>>>>>>");
        for (const intersection of intersections) {
            console.log("processing intersection");
            const object = intersection.object;
            if (object instanceof Face || object instanceof CurveEdge) {
                console.log(object instanceof Face, object instanceof CurveEdge)
                const parentItem = object.parentItem;
                if (this.mode.has(SelectionMode.Solid)) {
                    if (strategy.solid(object, parentItem as Solid)) return;
                }
                if (strategy.topologicalItem(object, parentItem as Solid)) return;
            } else if (object instanceof CurveSegment) {
                const parentItem = object.parentItem;
                if (strategy.curve3D(object, parentItem)) return;
            }
        }
    }

    onClick(intersections: THREE.Intersection[]) {
        this.onIntersection(intersections, this.clickStrategy);
    }

    onPointerMove(intersections: THREE.Intersection[]) {
        this.onIntersection(intersections, this.hoverStrategy);
    }

    deselectAll() {
        for (const object of this.selectedEdges) {
            this.selectedEdges.delete(object);
            const model = this.db.lookupTopologyItem(object);
            object.material = this.materials.lookup(model);
            this.signals.objectDeselected.dispatch(object);
        }
        for (const object of this.selectedFaces) {
            this.selectedFaces.delete(object);
            const model = this.db.lookupTopologyItem(object);
            object.material = this.materials.lookup(model);
            this.signals.objectDeselected.dispatch(object);
        }
        for (const object of this.selectedSolids) {
            this.selectedSolids.delete(object);
            this.signals.objectDeselected.dispatch(object);
        }
        this.selectedChildren.clear();
    }

    delete(item: visual.SpaceItem) {
        if (item instanceof visual.Solid) {
            this.selectedSolids.delete(item);
            this.selectedChildren.delete(item);
        } else if (item instanceof visual.SpaceInstance) {
            this.selectedCurves.delete(item);
        }
    }
}
