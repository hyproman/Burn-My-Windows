//////////////////////////////////////////////////////////////////////////////////////////
//          )                                                   (                       //
//       ( /(   (  (               )    (       (  (  (         )\ )    (  (            //
//       )\()) ))\ )(   (         (     )\ )    )\))( )\  (    (()/( (  )\))(  (        //
//      ((_)\ /((_|()\  )\ )      )\  '(()/(   ((_)()((_) )\ )  ((_)))\((_)()\ )\       //
//      | |(_|_))( ((_)_(_/(    _((_))  )(_))  _(()((_|_)_(_/(  _| |((_)(()((_|(_)      //
//      | '_ \ || | '_| ' \))  | '  \()| || |  \ V  V / | ' \)) _` / _ \ V  V (_-<      //
//      |_.__/\_,_|_| |_||_|   |_|_|_|  \_, |   \_/\_/|_|_||_|\__,_\___/\_/\_//__/      //
//                                 |__/                                                 //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const {Gio, Shell, GObject, Clutter} = imports.gi;
const ByteArray                      = imports.byteArray;

const ExtensionUtils = imports.misc.extensionUtils;
const Me             = imports.misc.extensionUtils.getCurrentExtension();
const utils          = Me.imports.src.utils;

//////////////////////////////////////////////////////////////////////////////////////////
// This is the base class for all shaders of Burn-My-Windows. It automagically loads    //
// the shader's source code from the resource file resources/shaders/<nick>.glsl and    //
// ensures that some standard uniforms are always updated.                              //
// Using Shell.GLSLEffect as a base class has some benefits and some drawbacks. The     //
// main benefit when compared to Clutter.ShaderEffect is that setting uniforms of types //
// vec2, vec3 or vec4 is supported via the API (with Clutter.ShaderEffect the GJS       //
// binding does not work properly). However, there are two drawbacks: On the one hand,  //
// the shader source code is cached statically - this means if we want to have a        //
// different shader, we have to derive a new class. Therefore, each effect has to       //
// derive its own class from the class below. This is encapsulated in the               //
// ShaderFactory, however it is some really awkward code. The other drawback is the     //
// hard-coded use of straight alpha (as opposed to premultiplied). This makes the       //
// shaders a bit more complicated than required.                                        //
//                                                                                      //
// The Shader fires two signals:                                                        //
//   * begin-animation:    This is called each time a new animation is started. It can  //
//                         be used to set uniform values which do not change during the //
//                         animation.                                                   //
//   * update-animation:   This is called at each frame during the animation. It can be //
//                         used to set uniforms which change during the animation.      //
//////////////////////////////////////////////////////////////////////////////////////////

var Shader = GObject.registerClass(
  {
    Signals: {
      'begin-animation': {
        param_types: [
          Gio.Settings.$gtype, GObject.TYPE_BOOLEAN, GObject.TYPE_BOOLEAN,
          Clutter.Actor.$gtype
        ]
      },
      'update-animation': {param_types: [GObject.TYPE_DOUBLE]},
      'end-animation': {}
    }
  },
  class Shader extends Shell.GLSLEffect {  // --------------------------------------------
    // The constructor automagically loads the shader's source code (in
    // vfunc_build_pipeline()) from the resource file resources/shaders/<nick>.glsl
    // resolving any #includes in this file.
    _init(nick) {
      this._nick = nick;

      // This will call vfunc_build_pipeline().
      super._init();

      // These will be updated during the animation.
      this._progress = 0;
      this._time     = 0;

      // Store standard uniform locations.
      this._uForOpening = this.get_uniform_location('uForOpening');
      this._uProgress   = this.get_uniform_location('uProgress');
      this._uDuration   = this.get_uniform_location('uDuration');
      this._uSize       = this.get_uniform_location('uSize');
      this._uPadding    = this.get_uniform_location('uPadding');
    }

    // This is called once each time the shader is used.
    beginAnimation(settings, forOpening, testMode, duration, actor) {

      // Reset progress value.
      this._progress = 0;

      // This is not necessarily symmetric, but I haven't figured out a way to
      // get the actual values...
      const padding = (actor.width - actor.meta_window.get_frame_rect().width) / 2;

      this.set_uniform_float(this._uPadding, 1, [padding]);
      this.set_uniform_float(this._uForOpening, 1, [forOpening]);
      this.set_uniform_float(this._uDuration, 1, [duration]);
      this.set_uniform_float(this._uSize, 2, [actor.width, actor.height]);

      this.emit('begin-animation', settings, forOpening, testMode, actor);
    }

    // This is called at each frame during the animation.
    updateAnimation(progress) {
      // Store the current progress value. The corresponding signal is emitted each frame
      // in vfunc_paint_target. We do not emit it here, as the pipeline which may be used
      // by handlers must not have been created yet.
      this._progress = progress;
    }

    // This will just emit the end-animation signal. It can be used to clean up any
    // resources required during the animation.
    endAnimation() {
      this.emit('end-animation');
    }

    // This is called by the constructor. This means, it's only called when the
    // effect is used for the first time.
    vfunc_build_pipeline() {

      // Shell.GLSLEffect requires the declarations and the main source code as separate
      // strings. As it's more convenient to store the in one GLSL file, we use a regex
      // here to split the source code in two parts.
      const code = this._loadShaderResource(`/shaders/${this._nick}.frag`);

      // Match anything between the curly brackets of "void main() {...}".
      const regex = RegExp('void main *\\(\\) *\\{([\\S\\s]+)\\}');
      const match = regex.exec(code);

      const declarations = code.substr(0, match.index);
      const main         = match[1];

      this.add_glsl_snippet(Shell.SnippetHook.FRAGMENT, declarations, main, true);
    }

    // We use this vfunc to trigger the update as it allows calling this.get_pipeline() in
    // the handler. This could still be null if called from the updateAnimation() above.
    vfunc_paint_target(...params) {
      this.emit('update-animation', this._progress);
      this.set_uniform_float(this._uProgress, 1, [this._progress]);
      super.vfunc_paint_target(...params);
    }

    // --------------------------------------------------------------------- private stuff

    // This loads the file at 'path' contained in the extension's resources to a
    // JavaScript string.
    _loadStringResource(path) {
      const data = Gio.resources_lookup_data(path, 0);
      return ByteArray.toString(ByteArray.fromGBytes(data));
    }

    // This loads a GLSL file from the extension's resources to a JavaScript string. The
    // code from "common.glsl" is prepended automatically.
    _loadShaderResource(path) {
      let common = this._loadStringResource('/shaders/common.glsl');
      let code   = this._loadStringResource(path);

      // Add a trailing newline. Else the GLSL compiler complains...
      return common + '\n' + code + '\n';
    }
  });
