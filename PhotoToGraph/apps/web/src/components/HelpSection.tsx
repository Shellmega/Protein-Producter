export function HelpSection() {
  return (
    <section className="ptg-help" data-testid="help-section">
      <h2>操作说明（PTG-2 先行图编辑）</h2>
      <div className="ptg-help-grid">
        <article>
          <h3>建点与平面</h3>
          <ul>
            <li>页头选择 <strong>XY / XZ / YZ</strong> 工作平面，输入有限数偏移后按“应用”。平面与偏移同时显示在画布左上角。</li>
            <li>在 <strong>建点</strong> 模式下单击画布：指针射线与当前工作平面求交，交点转换为图坐标后建立带稳定 ID 的结点。</li>
            <li>拖动（超过 4 CSS 像素）属于相机手势，不会建点；滚轮缩放同样不会建点。Escape、失焦或 pointercancel 会取消待处理手势。</li>
            <li>射线平行、共面、近乎平行、交点在后方、超出 ±1e6 scene_unit、非有限输入都会显示具体错误，且不改变图内容与 revision。</li>
          </ul>
        </article>
        <article>
          <h3>选择与坐标</h3>
          <ul>
            <li>在 <strong>选择</strong> 模式下单击结点，或点击右侧“结点列表”中的任意行（含被遮挡结点）进行选择；选中反馈唯一。</li>
            <li>在连线模式依次选择两个结点建立无向边；重复、自环和失效结点不会改变图。画面或空间交叉不自动连通。</li>
            <li>移动模式拖动彩色控件，按图坐标 X/Y/Z 或 XY/XZ/YZ 约束预览；松开一次提交，Escape、失焦或取消恢复原位。</li>
            <li>XYZ 三个字段使用完整精度，Enter 或“应用 XYZ”整组提交，Escape 恢复字段。删除、N 端与撤销重做在图编辑面板。</li>
            <li>相机旋转、平移、缩放、恢复视角只改变编辑器视图，不改变结点 ID/XYZ、图框架或 revision。</li>
            <li>坐标框架固定为右手 XYZ、单位 <code>scene_unit</code>；当前界面图框架到世界为单位变换，完整变换链由单元测试以非单位夹具验证。</li>
          </ul>
        </article>
        <article>
          <h3>参考图片</h3>
          <ul>
            <li>支持本地 PNG/JPEG；解码时应用 EXIF 方向校正，按解码后长宽比显示在独立参考平面上。</li>
            <li>可设置参考图的图框架位置、Euler XYZ 旋转（度）与正统一尺度；可把参考图平面选为当前建点平面，显示平面与求交平面始终是同一摆放。</li>
            <li>移动/旋转/缩放参考图不移动已建立结点；只有参考图来源 ID 集合实际增删时 revision 才递增一次。</li>
            <li>解码失败或无效图片保留先前有效状态；快速更换图片时迟到的解码结果不会覆盖新选择，旧位图与纹理会被释放。</li>
            <li>成功加载、替换或移除参考图是历史屏障，会清空撤销/重做；资源级撤销留待后续。图片摆放不构成屏障。</li>
          </ul>
        </article>
        <article>
          <h3>修订与范围</h3>
          <ul>
            <li>同一草稿的 <code>graph_id</code>、<code>frame_id</code>、<code>producer_instance_id</code> 稳定；revision 从 1 开始。</li>
            <li>实际建点、连线、移动、XYZ、删除、起点修改或撤销/重做各递增一次 revision；相机、选中、工作平面、参考图摆放、失败及同值不递增。</li>
            <li>本轮不发送 HTTP、不导入 GTP、不保存/恢复、不导出契约 JSON；这些属于后续阶段。</li>
            <li>页面上的“状态诊断（只读）”与 <code>window.__PTG__.snapshot()</code> 仅用于证据采集，不是契约导出。</li>
          </ul>
        </article>
      </div>
      <p className="ptg-help-foot">
        来源：Three.js 固定提交 <code>84fde13820dbccbb1f6688f44a20c59c9c740dc9</code> 的
        <code>examples/webgl_geometry_spline_editor.html</code>（MIT）的控制点拾取、相机互斥与显示更新逻辑，经 React + TypeScript +
        React Three Fiber + Drei 移植改造。来源映射与许可见 <code>apps/web/THIRD_PARTY_NOTICES.md</code>。
      </p>
    </section>
  );
}
